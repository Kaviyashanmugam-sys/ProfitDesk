const mongoose = require("mongoose");

const attachmentSchema = new mongoose.Schema(
  {
    filename:     { type: String },
    originalname: { type: String },
    mimetype:     { type: String },
    path:         { type: String },
  },
  { _id: false }
);

const billSchema = new mongoose.Schema(
  {
    // ── Auto-generated Bill ID: B/MM/YYYY-NNNNN ──────────────────────────────
    billId: { type: String, unique: true, sparse: true },

    // ── Relations ─────────────────────────────────────────────────────────────
    company:  { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: false },
    project:  { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: false },
    engineer: { type: mongoose.Schema.Types.ObjectId, ref: "User",    required: false },

    // ── Bill fields ───────────────────────────────────────────────────────────
    category: {
      type: String,
      // Accepts both enum labels AND raw IDs from ProfitDesk API
      // e.g. "Material" or "3"
      required: true,
    },

    amount:  { type: Number, required: true },

    // supplier_id from ProfitDesk stored as vendor string
    vendor:  { type: String, default: "" },

    remarks: { type: String, default: "" },

    attachments: { type: [attachmentSchema], default: [] },

    status: {
      type:    String,
      enum:    ["Not Started", "In Progress", "Completed"],
      default: "Not Started",
    },

    date: { type: Date, default: Date.now },

    // ── WhatsApp Flow source tracking ─────────────────────────────────────────
    source: {
      type:    String,
      enum:    ["whatsapp_flow", "whatsapp_chat", "web", "api"],
      default: "api",
    },
  },
  { timestamps: true }
);

// ── Auto-generate billId if not set ──────────────────────────────────────────
billSchema.pre("save", async function (next) {
  if (!this.billId) {
    const now   = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const year  = now.getFullYear();
    const count = await mongoose.model("Bill").countDocuments();
    this.billId = `B/${month}/${year}-${String(count + 1).padStart(5, "0")}`;
  }
  next();
});

module.exports = mongoose.model("Bill", billSchema);