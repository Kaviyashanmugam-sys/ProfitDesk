const express = require("express");
const router = express.Router();
const Project = require("../models/Project");
const { protect } = require("../middleware/authMiddleware");

// GET /api/projects?company=id
router.get("/", protect, async (req, res) => {
  try {
    const filter = req.query.company ? { company: req.query.company  } : {};
    const projects = await Project.find(filter).populate("company");
    res.json(projects);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/projects
router.post("/", protect, async (req, res) => {
  try {
    const project = await Project.create(req.body);
    res.status(201).json(project);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
