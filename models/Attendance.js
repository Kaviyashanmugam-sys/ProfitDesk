const mongoose = require("mongoose");

const attendanceSchema = new mongoose.Schema(
  {
    engineer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    date: { type: Date, required: true },
    time: { type: String },
    status: { type: String, enum: ["Present", "Absent"], required: true },
    remarks: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Attendance", attendanceSchema);
