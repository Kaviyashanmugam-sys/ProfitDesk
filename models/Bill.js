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
      type:     String,
      required: true,
    },

    amount:  { type: Number, required: true },

    // ✅ FIX #2: vendor is String — always pass clean string, not number/object
    vendor:  { type: String, default: "" },

    remarks: { type: String, default: "" },

    attachments: { type: [attachmentSchema], default: [] },

    status: {
      type:    String,
      enum:    ["Not Started", "In Progress", "Completed"],
      default: "Not Started",
    },

    date: { type: Date, default: Date.now },

    // ── Source tracking ───────────────────────────────────────────────────────
    // ✅ FIX #3: whatsappRoutes now passes source: "whatsapp_flow" correctly
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