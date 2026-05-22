const express = require("express");
const router = express.Router();
const Attendance = require("../models/Attendance");
const { protect } = require("../middleware/authMiddleware");

// GET /api/attendance
router.get("/", protect, async (req, res) => {
  try {
    const records = await Attendance.find({ engineer: req.user._id })
      .populate("project", "name")
      .populate("company", "name")
      .sort({ date: -1 });
    res.json(records);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/attendance
router.post("/", protect, async (req, res) => {
  try {
    const record = await Attendance.create({
      ...req.body,
      engineer: req.user._id,
    });
    res.status(201).json(record);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
