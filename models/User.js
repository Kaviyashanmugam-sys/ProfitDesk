const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    mobile: { type: String, required: true, unique: true },
    role: { type: String, enum: ["site_engineer", "admin"], default: "site_engineer" },
    companies: [{ type: mongoose.Schema.Types.ObjectId, ref: "Company" }],
    otp: { type: String },
    otpExpiry: { type: Date },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
