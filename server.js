const express  = require("express");
const mongoose = require("mongoose");
const cors     = require("cors");
const dotenv   = require("dotenv");
const path     = require("path");

dotenv.config();
const app = express();

// ═══════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════════

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(cors());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Request logging
app.use((req, res, next) => {
  const logPaths = ["/", "/whatsapp", "/flow"];
  if (logPaths.some((p) => req.path === p || req.path.startsWith(p))) {
    console.log(`\n📨 ${req.method} /webhook${req.path}`);
    console.log(`   Content-Type: ${req.headers["content-type"] || "-"}`);
    if (req.method === "POST") {
      console.log(`   Body Keys: ${Object.keys(req.body || {}).join(", ")}`);
      // Log flow screen for easier debugging
      if (req.path === "/flow" && req.body?.screen) {
        console.log(`   Flow Screen: ${req.body.screen}`);
      }
    }
  }
  next();
});

// ═══════════════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

app.use("/api/auth",       require("./routes/authRoutes"));
app.use("/api/companies",  require("./routes/companyRoutes"));
app.use("/api/projects",   require("./routes/projectRoutes"));
app.use("/api/bills",      require("./routes/billRoutes"));
app.use("/api/attendance", require("./routes/attendanceRoutes"));
app.use("/api/users",      require("./routes/userRoutes"));

// ⭐ WhatsApp Routes
// /webhook/whatsapp — chat messages
// /webhook/flow     — WhatsApp Flow screen handler
app.use("/webhook", require("./routes/whatsappRoutes"));

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "✅ Server is running", time: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MONGODB
// ═══════════════════════════════════════════════════════════════════════════════

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/profitdesk";

mongoose
  .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log("✅ MongoDB Connected");
    console.log(`   URI: ${MONGO_URI.split("@")[1] || MONGO_URI}`);
  })
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err.message);
    process.exit(1);
  });

mongoose.connection.on("disconnected", () => console.warn("⚠️  MongoDB disconnected"));
mongoose.connection.on("error",        (err) => console.error("❌ MongoDB error:", err.message));

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER
// ═══════════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log("\n" + "═".repeat(80));
  console.log("🚀 ProfitDesk Server Started");
  console.log("═".repeat(80));
  console.log(`📡 Port:           ${PORT}`);
  console.log(`🔗 Health:         http://localhost:${PORT}/health`);
  console.log(`📲 WA Webhook:     http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`📋 Flow Webhook:   http://localhost:${PORT}/webhook/flow`);
  console.log("\n⚙️  Environment:");
  console.log(`   MONGO_URI:                ${process.env.MONGO_URI                ? "✅" : "❌"}`);
  console.log(`   WHATSAPP_PHONE_NUMBER_ID: ${process.env.WHATSAPP_PHONE_NUMBER_ID ? "✅" : "❌"}`);
  console.log(`   WHATSAPP_ACCESS_TOKEN:    ${process.env.WHATSAPP_ACCESS_TOKEN    ? "✅" : "❌"}`);
  console.log(`   WHATSAPP_VERIFY_TOKEN:    ${process.env.WHATSAPP_VERIFY_TOKEN    ? "✅" : "❌"}`);
  console.log(`   FLOW_ID:                  ${process.env.FLOW_ID                  ? "✅" : "❌"}`);
  console.log(`   CUSTOMER_API_BASE_URL:    ${process.env.CUSTOMER_API_BASE_URL    ? "✅" : "❌"}`);
  console.log("═".repeat(80) + "\n");
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing gracefully...");
  mongoose.connection.close();
  process.exit(0);
});

module.exports = app;