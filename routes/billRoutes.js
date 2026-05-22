const express = require("express");
const router = express.Router();
const Bill = require("../models/Bill");
const { protect } = require("../middleware/authMiddleware");
const upload = require("../config/multerConfig");

// GET /api/bills?company=id
router.get("/", protect, async (req, res) => {
  try {
    const filter = { engineer: req.user._id };
    if (req.query.company) filter.company = req.query.company;
    const bills = await Bill.find(filter)
      .populate("project", "name")
      .populate("company", "name")
      .populate("engineer", "name")
      .sort({ createdAt: -1 });
    res.json(bills);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /api/bills/:id
router.get("/:id", protect, async (req, res) => {
  try {
    const bill = await Bill.findById(req.params.id)
      .populate("project")
      .populate("company")
      .populate("engineer", "name mobile");
    if (!bill) return res.status(404).json({ message: "Bill not found" });
    res.json(bill);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /api/bills - Create bill with file upload
router.post("/", protect, upload.array("attachments", 10), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0)
      return res.status(400).json({ message: "At least one attachment is required" });

    const attachments = req.files.map((f) => ({
      filename: f.filename,
      originalname: f.originalname,
      mimetype: f.mimetype,
      path: f.path,
    }));

    const bill = await Bill.create({
      ...req.body,
      engineer: req.user._id,
      attachments,
    });

    const populated = await bill.populate(["project", "company", "engineer"]);
    res.status(201).json(populated);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PATCH /api/bills/:id/status
router.patch("/:id/status", protect, async (req, res) => {
  try {
    const bill = await Bill.findByIdAndUpdate(
      req.params.id,
      { status: req.body.status },
      { new: true }
    );
    res.json(bill);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
