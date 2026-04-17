const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6, pingTimeout: 60000, pingInterval: 25000 });

// Keep Node alive on unhandled errors — a single bad event must never kill the server
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));

// Wrap socket event callbacks so any error is caught and logged instead of crashing
function safe(fn) {
  return function (...args) {
    try { fn(...args); } catch (e) { console.error("[safe] handler error:", e); }
  };
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// ── CONFIG ──
const ADMIN_PASSWORD = "admin123";
const SERVER_URL = "https://zs8-quiz.kijmoshi.xyz"; // Change to your server's URL or IP
// const REDIRECT_URL = `bit.ly/zs8-quiz`; // Short URL for easy sharing (optional)
const QUESTIONS = [
  
  { q: "Jaki numer miało gimnazjum, które istniało przed ZS8?", a: "11", b: "7", c: "13", d: "21", correct: "c" },
  
  { q: "W którym roku ZS8 rozpoczęło swoją działalność?", a: "2016", b: "2017", c: "2019", d: "2021", correct: "c" },
  
  { q: "Jak nazywa sie druzyna ktora dwokrotnie odniosla sukcess w Ogolnopolskiej Olimpiadzie Krewatynosci.", a: "Beta Squad", b: "Gamma Team", c: "Alfa Team", d: "Delta Force", correct: "c" },

  { q: "Kto prowadzi Szkolne Koło Turystyczne Skalnik?", a: "E. Sojka", b: "K. Sojka", c: "T. Fulara", d: "M. Tokarek", correct: "b" },
  
  { q: "W którym roku założono zespół Crossover?", a: "2000", b: "2005", c: "2003", d: "2008", correct: "c" },
  
  { q: "w jakim stylu architektonicznnym zbudowano naszą szkołę?", a: "Gotycki", b: "Neogotycki", c: "Modernistyczny", d: "Barokowy", correct: "b" },

  { q: "Jaki jest numer sali w ktorej jest najwiecej fauny i flory?", a: "18", b: "21", c: "15", d: "24", correct: "b" },

  { q: "Ilu nauczycieli wychowania fizycznego uczy w naszej szkole?", a: "6", b: "7", c: "8", d: "10", correct: "c" },

  { q: "Która nauczycielka odpowiada za Szkolny Wolontariat?", a: "M. Rabiej", b: "E. Liszewska", c: "A. Jagucka", d: "B. Motylewska", correct: "a" },

  { q: "Jak nazywa się święto obchodzone w naszej szkole 31 października?", a: "Halloween", b: "Dziadoween", c: "Dzień Straszenia", d: "Noc Duchów", correct: "b" },
  
  { q: "W którym roku zamontoano ten element?", a: "2022", b: "2023", c: "2024", d: "2025", correct: "c", media: "image.png" },
  // w ktorym zamontowano ten element + zdj (zegar)
];
const TIME_PER_QUESTION = 20; // seconds

// ── STATE ──
let players = new Map(); // socketId -> { name, class, score, answers[] }
let gameState = "lobby"; // lobby | question | reveal | leaderboard | finished
let currentQuestion = -1;
let questionTimer = null;
let questionStartTime = 0;
let autoplay = false;
let autoplayTimer = null;

// ── ROUTES ──
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/screen", (_req, res) => res.sendFile(path.join(__dirname, "public", "screen.html")));

// ── HELPERS ──
function getPlayerList() {
  return Array.from(players.values()).map(p => ({ name: p.name, class: p.class }));
}

function getTop5() {
  return Array.from(players.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((p, i) => ({ rank: i + 1, name: p.name, class: p.class, score: p.score }));
}

function getTop3Classes() {
  const classScores = {};
  for (const p of players.values()) {
    if (!classScores[p.class]) classScores[p.class] = { total: 0, count: 0 };
    classScores[p.class].total += p.score;
    classScores[p.class].count++;
  }
  return Object.entries(classScores)
    .map(([name, d]) => ({ name, avgScore: Math.round(d.total / d.count), totalScore: d.total, count: d.count }))
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 3)
    .map((c, i) => ({ rank: i + 1, ...c }));
}

function answeredCount() {
  let count = 0;
  for (const p of players.values()) {
    if (p.answers[currentQuestion] !== undefined) count++;
  }
  return count;
}

function answerDistribution() {
  const dist = { a: 0, b: 0, c: 0, d: 0 };
  for (const p of players.values()) {
    const ans = p.answers[currentQuestion];
    if (ans && dist[ans] !== undefined) dist[ans]++;
  }
  return dist;
}

function sendQuestion() {
  if (currentQuestion < 0 || currentQuestion >= QUESTIONS.length) {
    console.error("[sendQuestion] invalid currentQuestion:", currentQuestion);
    return;
  }
  const q = QUESTIONS[currentQuestion];
  questionStartTime = Date.now();
  gameState = "question";

  io.to("screens").emit("show-question", {
    index: currentQuestion,
    total: QUESTIONS.length,
    question: q.q,
    a: q.a, b: q.b, c: q.c, d: q.d,
    time: TIME_PER_QUESTION,
    media: q.media || null,
  });

  io.to("players").emit("show-answers", {
    index: currentQuestion,
    total: QUESTIONS.length,
    a: q.a, b: q.b, c: q.c, d: q.d,
    time: TIME_PER_QUESTION,
  });

  io.to("admins").emit("question-started", { index: currentQuestion, total: QUESTIONS.length });

  questionTimer = setTimeout(() => revealAnswer(), TIME_PER_QUESTION * 1000);
}

function revealAnswer() {
  if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }
  if (currentQuestion < 0 || currentQuestion >= QUESTIONS.length) {
    console.error("[revealAnswer] invalid currentQuestion:", currentQuestion);
    return;
  }
  gameState = "reveal";
  const q = QUESTIONS[currentQuestion];

  io.to("screens").emit("reveal-answer", {
    correct: q.correct,
    distribution: answerDistribution(),
    correctText: q[q.correct],
  });

  // Tell each player if they were correct
  for (const [sid, p] of players) {
    const ans = p.answers[currentQuestion];
    io.to(sid).emit("answer-result", {
      correct: ans === q.correct,
      correctAnswer: q.correct,
      yourAnswer: ans || null,
    });
  }

  io.to("admins").emit("reveal-done", { index: currentQuestion });

  // Autoplay: auto-advance after 3 seconds
  if (autoplay) {
    if (autoplayTimer) clearTimeout(autoplayTimer);
    autoplayTimer = setTimeout(() => {
      autoplayTimer = null;
      if (gameState !== "reveal") return;
      currentQuestion++;
      if (currentQuestion >= QUESTIONS.length) {
        showFinalResults();
      } else {
        sendQuestion();
      }
    }, 3000);
  }
}

function showFinalResults() {
  gameState = "finished";
  const top5 = getTop5();
  const top3classes = getTop3Classes();
  const results = { top5, top3classes };

  // Send leaderboard + personal scores to each player
  for (const [sid, player] of players) {
    io.to(sid).emit("final-results", {
      ...results,
      personalScore: player.score,
      rank: top5.findIndex(p => p.name === player.name) + 1 || null,
    });
  }

  // Send general leaderboard to screens
  io.to("screens").emit("final-results", results);
}

// ── SOCKET.IO ──
io.on("connection", (socket) => {
  // Player joins
  socket.on("join", safe(({ name, playerClass } = {}) => {
    if (!name || !playerClass || typeof name !== "string" || typeof playerClass !== "string") return;
    name = name.trim().slice(0, 40);
    playerClass = playerClass.trim().slice(0, 20);
    if (!name || !playerClass) return;

    function normalizeClassName(className) {
      return className.trim().toLowerCase().replace(/\s+/g, "").replace(/^(\d+)([a-z])$/i, (_, num, letter) => `${num}${letter.toLowerCase()}`);
    }

    const normalizedClass = normalizeClassName(playerClass);
    players.set(socket.id, { name, class: normalizedClass, score: 0, answers: [] });
    socket.join("players");
    socket.emit("joined", { state: gameState, playerCount: players.size });
    io.to("screens").emit("player-count", { count: players.size });
    io.to("admins").emit("player-count", { count: players.size, players: getPlayerList() });

    // If game already in progress, sync the late joiner to current state
    if (gameState === "question") {
      const q = QUESTIONS[currentQuestion];
      const elapsed = (Date.now() - questionStartTime) / 1000;
      const remaining = Math.max(0, TIME_PER_QUESTION - elapsed);
      socket.emit("show-answers", {
        index: currentQuestion, total: QUESTIONS.length,
        a: q.a, b: q.b, c: q.c, d: q.d, time: remaining,
      });
    } else if (gameState === "reveal") {
      // Joined too late to answer — show result screen with wrong
      const q = QUESTIONS[currentQuestion];
      socket.emit("answer-result", { correct: false, correctAnswer: q.correct, yourAnswer: null });
    } else if (gameState === "finished") {
      socket.emit("final-results", { top5: getTop5(), top3classes: getTop3Classes() });
    }
  }));

  // Player answers
  socket.on("answer", safe(({ answer } = {}) => {
    if (gameState !== "question") return;
    if (!["a", "b", "c", "d"].includes(answer)) return;
    const player = players.get(socket.id);
    if (!player) return;
    if (player.answers[currentQuestion] !== undefined) return; // already answered

    player.answers[currentQuestion] = answer;
    const q = QUESTIONS[currentQuestion];
    if (!q) return;
    if (answer === q.correct) {
      const elapsed = (Date.now() - questionStartTime) / 1000;
      const timeBonus = Math.max(0, Math.round((1 - elapsed / TIME_PER_QUESTION) * 30));
      player.score += 30 + timeBonus;
    }

    socket.emit("answer-locked", { answer });
    const cnt = answeredCount();
    io.to("screens").emit("answer-count", { count: cnt, total: players.size });
    io.to("admins").emit("answer-count", { count: cnt, total: players.size });

    // Autoplay: skip timer when all answered
    if (autoplay && cnt >= players.size && players.size > 0) {
      revealAnswer();
    }
  }));

  // Admin auth
  socket.on("admin-login", safe(({ password } = {}) => {
    if (password === ADMIN_PASSWORD) {
      socket.join("admins");
      socket.emit("admin-ok", { state: gameState, questionIndex: currentQuestion, playerCount: players.size, totalQuestions: QUESTIONS.length, autoplay });
    } else {
      socket.emit("admin-fail");
    }
  }));

  // Screen joins
  socket.on("screen-join", safe(() => {
    socket.join("screens");
    socket.emit("screen-state", { state: gameState, playerCount: players.size, joinUrl: SERVER_URL });

    if (gameState === "question") {
      const q = QUESTIONS[currentQuestion];
      const elapsed = (Date.now() - questionStartTime) / 1000;
      const remaining = Math.max(0, TIME_PER_QUESTION - elapsed);
      socket.emit("show-question", {
        index: currentQuestion, total: QUESTIONS.length,
        question: q.q, a: q.a, b: q.b, c: q.c, d: q.d,
        time: remaining,
        media: q.media || null,
      });
    } else if (gameState === "reveal") {
      const q = QUESTIONS[currentQuestion];
      socket.emit("show-question", {
        index: currentQuestion, total: QUESTIONS.length,
        question: q.q, a: q.a, b: q.b, c: q.c, d: q.d,
        time: 0,
        media: q.media || null,
      });
      socket.emit("reveal-answer", {
        correct: q.correct,
        distribution: answerDistribution(),
        correctText: q[q.correct],
      });
    } else if (gameState === "finished") {
      socket.emit("final-results", { top5: getTop5(), top3classes: getTop3Classes() });
    }
  }));

  // Admin controls
  socket.on("start-quiz", safe(() => {
    if (!socket.rooms.has("admins")) return;
    if (gameState !== "lobby") return;
    currentQuestion = 0;
    sendQuestion();
  }));

  socket.on("next-question", safe(() => {
    if (!socket.rooms.has("admins")) return;
    if (gameState !== "reveal") return;
    currentQuestion++;
    if (currentQuestion >= QUESTIONS.length) {
      showFinalResults();
    } else {
      sendQuestion();
    }
  }));

  socket.on("skip-timer", safe(() => {
    if (!socket.rooms.has("admins")) return;
    if (gameState !== "question") return;
    revealAnswer();
  }));

  socket.on("toggle-autoplay", safe(() => {
    if (!socket.rooms.has("admins")) return;
    autoplay = !autoplay;
    io.to("admins").emit("autoplay-state", { autoplay });
  }));

  socket.on("reset-quiz", safe(() => {
    if (!socket.rooms.has("admins")) return;
    if (questionTimer) { clearTimeout(questionTimer); questionTimer = null; }
    if (autoplayTimer) { clearTimeout(autoplayTimer); autoplayTimer = null; }
    gameState = "lobby";
    currentQuestion = -1;
    for (const p of players.values()) { p.score = 0; p.answers = []; }
    io.emit("quiz-reset");
  }));

  // Disconnect
  socket.on("disconnect", safe(() => {
    players.delete(socket.id);
    io.to("screens").emit("player-count", { count: players.size });
    io.to("admins").emit("player-count", { count: players.size, players: getPlayerList() });
  }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Quiz server running on http://localhost:${PORT}`));