const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config();
const app = express();

// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ MIDDLEWARE - ORDER MATTERS
// ═══════════════════════════════════════════════════════════════════════════════

// 1️⃣ Body Parser FIRST (before routes)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// 2️⃣ CORS
app.use(cors());

// 3️⃣ Static Files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// 4️⃣ Request Logging
app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/flow") {
    console.log(`\n📨 ${req.method} /webhook${req.path}`);
    console.log(`   Headers:`, req.headers["content-type"]);
    if (req.method === "POST") {
      console.log(`   Body Keys:`, Object.keys(req.body || {}).join(", "));
    }
  }
  next();
});

// ═══════════════════════════════════════════════════════════════════════════════
// 📦 ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.use("/api/auth",       require("./routes/authRoutes"));
app.use("/api/companies",  require("./routes/companyRoutes"));
app.use("/api/projects",   require("./routes/projectRoutes"));
app.use("/api/bills",      require("./routes/billRoutes"));
app.use("/api/attendance", require("./routes/attendanceRoutes"));
app.use("/api/users",      require("./routes/userRoutes"));

// ⭐ WhatsApp Routes
app.use("/webhook", require("./routes/whatsappRoutes"));

// Health Check
app.get("/health", (req, res) => {
  res.json({ status: "✅ Server is running" });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 💾 MONGODB CONNECTION
// ═══════════════════════════════════════════════════════════════════════════════

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/profitdesk";

mongoose
  .connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("✅ MongoDB Connected");
    console.log(`   URI: ${MONGO_URI.split("@")[1] || MONGO_URI}`);
  })
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err.message);
    process.exit(1);
  });

mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ MongoDB disconnected");
});

mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB error:", err.message);
});

// ═══════════════════════════════════════════════════════════════════════════════
// 🚀 SERVER START
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("\n" + "═".repeat(80));
  console.log("🚀 ProfitDesk Server Started");
  console.log("═".repeat(80));
  console.log(`📡 Port: ${PORT}`);
  console.log(`🔗 Health: http://localhost:${PORT}/health`);
  console.log(`📲 Webhook: http://localhost:${PORT}/webhook`);
  console.log(`🔄 Flow:    http://localhost:${PORT}/webhook/flow`);
  console.log("\n⚙️  Environment:");
  console.log(`   MONGO_URI:                ${process.env.MONGO_URI                ? "✅" : "❌"}`);
  console.log(`   WHATSAPP_PHONE_NUMBER_ID: ${process.env.WHATSAPP_PHONE_NUMBER_ID ? "✅" : "❌"}`);
  console.log(`   WHATSAPP_ACCESS_TOKEN:    ${process.env.WHATSAPP_ACCESS_TOKEN    ? "✅" : "❌"}`);
  console.log(`   WHATSAPP_VERIFY_TOKEN:    ${process.env.WHATSAPP_VERIFY_TOKEN    ? "✅" : "❌"}`);
  console.log(`   FLOW_ID:                  ${process.env.FLOW_ID                  ? "✅" : "❌"}`);
  console.log(`   FLOW_PRIVATE_KEY:         ${process.env.FLOW_PRIVATE_KEY         ? "✅" : "❌"}`);
  console.log("═".repeat(80) + "\n");
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing gracefully...");
  mongoose.connection.close();
  process.exit(0);
});

module.exports = app;