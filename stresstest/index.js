const { io: ioClient } = require("socket.io-client");
const express = require("express");
const fs = require("fs");
const path = require("path");

// ── CONFIG ──
const SERVER_URL = "http://localhost:3000/";
const BOT_COUNT = 6000;           // how many bots to connect
const JOIN_DELAY_MS = 1;      // delay between each bot joining (ms)
const ANSWER_DELAY_MIN = 1000;  // min ms before answering
const ANSWER_DELAY_MAX = 8000;  // max ms before answering

const CLASSES = ["8a", "8b", "8c", "8d", "7a", "7b", "7c"];
const NAMES = [
  "Bot_Ala", "Bot_Kasia", "Bot_Marek", "Bot_Tomek", "Bot_Ola",
  "Bot_Piotr", "Bot_Zuzia", "Bot_Janek", "Bot_Ewa", "Bot_Kamil",
  "Bot_Marta", "Bot_Dawid", "Bot_Magda", "Bot_Hubert", "Bot_Natalia",
  "Bot_Bartek", "Bot_Zosia", "Bot_Maciek", "Bot_Hania", "Bot_Olek",
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const bots = [];

function createBot(i) {
  const name = i < NAMES.length ? NAMES[i] : `Bot_${i + 1}`;
  const playerClass = randomFrom(CLASSES);

  const socket = ioClient(SERVER_URL, {
    transports: ["websocket"],
    forceNew: true,
  });

  socket.on("connect", () => {
    console.log(`[${name}] connected`);
    socket.emit("join", { name, playerClass });
  });

  socket.on("joined", (data) => {
    console.log(`[${name}] joined (${playerClass}) — state: ${data.state}, players: ${data.playerCount}`);
  });

  socket.on("show-answers", (data) => {
    const delay = randomInt(ANSWER_DELAY_MIN, ANSWER_DELAY_MAX);
    const answer = randomFrom(["a", "b", "c", "d"]);
    setTimeout(() => {
      socket.emit("answer", { answer });
      console.log(`[${name}] answered Q${data.index + 1}: ${answer}`);
    }, delay);
  });

  socket.on("answer-result", (data) => {
    console.log(`[${name}] result: ${data.correct ? "CORRECT" : "wrong"} (correct=${data.correctAnswer}, mine=${data.yourAnswer})`);
  });

  socket.on("answer-locked", () => {});

  socket.on("final-results", (data) => {
    console.log(`[${name}] game over!`);
  });

  socket.on("disconnect", () => {
    console.log(`[${name}] disconnected`);
  });

  socket.on("connect_error", (err) => {
    console.error(`[${name}] connection error: ${err.message}`);
  });

  bots.push(socket);
}

// ── MAIN ──
console.log(`Stress test: connecting ${BOT_COUNT} bots to ${SERVER_URL}...`);

for (let i = 0; i < BOT_COUNT; i++) {
  setTimeout(() => createBot(i), i * JOIN_DELAY_MS);
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nDisconnecting all bots...");
  for (const s of bots) s.disconnect();
  setTimeout(() => process.exit(0), 500);
});

const app = express();
const PORT = 3001;
const QUESTIONS_FILE = path.join(__dirname, "questions.json");

app.use(express.json());

// Ensure questions file exists
if (!fs.existsSync(QUESTIONS_FILE)) {
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify([]));
}

// Get all questions
app.get("/questions", (req, res) => {
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE));
  res.json(questions);
});

// Add a new question
app.post("/questions", (req, res) => {
  const { question, options, correctAnswer } = req.body;
  if (!question || !options || !correctAnswer) {
    return res.status(400).json({ error: "Invalid question data" });
  }
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE));
  questions.push({ id: Date.now(), question, options, correctAnswer });
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions));
  res.status(201).json({ message: "Question added" });
});

// Update a question
app.put("/questions/:id", (req, res) => {
  const { id } = req.params;
  const { question, options, correctAnswer } = req.body;
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE));
  const index = questions.findIndex((q) => q.id === parseInt(id));
  if (index === -1) {
    return res.status(404).json({ error: "Question not found" });
  }
  questions[index] = { id: parseInt(id), question, options, correctAnswer };
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions));
  res.json({ message: "Question updated" });
});

// Delete a question
app.delete("/questions/:id", (req, res) => {
  const { id } = req.params;
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE));
  const filteredQuestions = questions.filter((q) => q.id !== parseInt(id));
  if (questions.length === filteredQuestions.length) {
    return res.status(404).json({ error: "Question not found" });
  }
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(filteredQuestions));
  res.json({ message: "Question deleted" });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Admin API running on http://localhost:${PORT}`);
});
