const express = require("express");
const router = express.Router();
const Company = require("../models/Company");
const { protect } = require("../middleware/authMiddleware");

// GET /api/companies - Get user's companies
router.get("/", protect, async (req, res) => {
  try {
    const user = await require("../models/User").findById(req.user._id).populate("companies");
    res.json(user.companies);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/companies - Create company (admin)
router.post("/", protect, async (req, res) => {
  try {
    const company = await Company.create({ name: req.body.name });
    res.status(201).json(company);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
