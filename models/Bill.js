const mongoose = require("mongoose");

const billSchema = new mongoose.Schema(
  {
    billId:   { type: String, unique: true },
    company:  { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    project:  { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: false }, // ✅ false — user type panna name match aagala irundhalum save aagum
    engineer: { type: mongoose.Schema.Types.ObjectId, ref: "User",    required: true },
    category: {
      type: String,
      enum: ["Material", "Labour", "Machineries", "Others"],
      required: true,
    },
    amount:   { type: Number, required: true },  // ✅ amount field add panninen
    vendor:   { type: String },
    remarks:  { type: String },
    attachments: [
      {
        filename:     String,
        originalname: String,
        mimetype:     String,
        path:         String,
      },
    ],
    status: {
      type: String,
      enum: ["Not Started", "In Progress", "Completed"],
      default: "In Progress",
    },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Auto-generate Bill ID: B/MM/YYYY-NNNNN
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