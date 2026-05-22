const express = require("express");
const router = express.Router();
const axios = require("axios");
const Project = require("../models/Project");
const Bill = require("../models/Bill");

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const FLOW_ID = process.env.FLOW_ID;

console.log("📱 PHONE_NUMBER_ID:", PHONE_NUMBER_ID);
console.log("🔑 ACCESS_TOKEN loaded:", ACCESS_TOKEN ? "✅ Yes" : "❌ No");
console.log("🔄 FLOW_ID:", FLOW_ID);

// ─── Keyword Replies ───────────────────────────────────────────────────────────
const responses = [
  {
    keywords: ["hi", "hello", "hey", "start", "help", "menu"],
    reply: "👋 Welcome to ProfitDesk Site Engineer Bot!\n\nI can help you with:\n🔐 Login\n🏢 Company Selection\n📊 Dashboard\n🧾 Bill Management\n📎 Attachments\n✅ Attendance\n\nType *portal* to open the interactive menu!",
  },
  {
    keywords: ["login", "otp", "sign in", "mobile", "number"],
    reply: "🔐 Login Process:\n\n1. Open ProfitDesk app\n2. Enter registered mobile number\n3. Tap OTP button\n4. Enter OTP received",
  },
  {
    keywords: ["company", "select company", "dropdown", "organisation"],
    reply: "🏢 Company Selection:\n\nAfter login:\n• Multiple companies → dropdown appears at top\n• Select your company to proceed",
  },
  {
    keywords: ["dashboard", "home", "transaction", "recent", "show all"],
    reply: "📊 Dashboard Overview:\n\nHome screen shows:\n• Recent transactions\n• Previously created bills with status",
  },
  {
    keywords: ["bill status", "status", "in progress", "not started"],
    reply: "🚀 Bill Status:\n\n• 🔴 Not Started\n• 🟡 In Progress\n• 🟢 Completed",
  },
  {
    keywords: ["create bill", "new bill", "add bill", "plus", "expense"],
    reply: "➕ Create a New Bill:\n\n1. Tap + icon at bottom\n2. Fill: Date, Project, Category, Vendor, Amount\n3. Add attachments\n4. Submit",
  },
  {
    keywords: ["attach", "attachment", "file", "image", "photo", "pdf", "upload", "camera", "gallery"],
    reply: "📎 Bill Attachments (Mandatory):\n\n1. Tap Add Files and choose:\n• Camera\n• Gallery\n• Document",
  },
  {
    keywords: ["submit", "save", "generate"],
    reply: "✅ Submit Bill:\n\n1. Fill all details\n2. Add attachments\n3. Tap Submit → Bill ID generated",
  },
  {
    keywords: ["work", "activity", "update", "tracking", "data entry"],
    reply: "📋 Work Updates:\n\n1. Tap any bill to open\n2. Bills tab - view Invoice\n3. Data Entry tab - add work updates",
  },
  {
    keywords: ["attendance", "present", "absent"],
    reply: "✅ Attendance:\n\n1. Tap Attendance icon (bottom)\n2. Entry table\n3. Select Date, Site, Project\n4. Mark Present/Absent",
  },
  {
    keywords: ["logout", "log out", "sign out", "exit", "bye"],
    reply: "🚪 Logout:\n\n1. Swipe from LEFT side\n2. Side menu opens\n3. Tap Logout (red)\n\n🔐 Session ends safely",
  },
  {
    keywords: ["category", "material", "labour", "labor", "machineries", "others"],
    reply: "🗂️ Bill Categories:\n\n• 🧱 Material\n• 👷 Labour\n• 🚜 Machineries\n• 📦 Others",
  },
];

const fallback =
  "😕 Sorry, I didn't understand that.\n\nTry asking:\n• login\n• create bill\n• attachment\n• attendance\n• logout\n\nType *portal* to open the full menu.";

function getReply(text) {
  const lower = text.toLowerCase();
  for (const r of responses) {
    if (r.keywords.some((k) => lower.includes(k))) return r.reply;
  }
  return fallback;
}

// ─── Send Text Message ─────────────────────────────────────────────────────────
async function sendWhatsApp(to, body) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body },
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("❌ sendWhatsApp error:", err.response?.data || err.message);
  }
}

// ─── Send Flow Message ─────────────────────────────────────────────────────────
async function sendFlowMessage(to) {
  try {
    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "flow",
        header: { type: "text", text: "🏗️ ProfitDesk" },
        body: { text: "Site Engineer Portal — Select what you want to do" },
        footer: { text: "ProfitDesk App" },
        action: {
          name: "flow",
          parameters: {
            flow_id: FLOW_ID,
            flow_message_version: "3",        // ✅ Fixed — இது add பண்ணினோம்
            flow_cta: "Open Portal",
            mode: "draft",
            flow_action: "navigate",
            flow_action_payload: {
              screen: "MAIN_MENU",
            },
          },
        },
      },
    };

    console.log("📤 Sending flow to:", to);
    console.log("📤 Payload:", JSON.stringify(payload, null, 2));

    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Flow sent:", response.data);
  } catch (err) {
    console.error("❌ sendFlowMessage error:", err.response?.data || err.message);
  }
}

// ─── Webhook Verify (GET) ──────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Receive Incoming Message (POST) ──────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return res.sendStatus(200);

    const msg = messages[0];
    const from = msg.from;
    const text = msg.text?.body;

    if (!text) return res.sendStatus(200);
    console.log(`📩 From ${from}: ${text}`);

    if (
      text.toLowerCase().includes("portal") ||
      text.toLowerCase().includes("open menu")
    ) {
      await sendFlowMessage(from);
      return res.sendStatus(200);
    }

    await sendWhatsApp(from, getReply(text));
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    console.error("❌ Full error:", err.response?.data);
    res.sendStatus(500);
  }
});

// ─── Flow Data Exchange Endpoint (POST /flow) ─────────────────────────────────
router.post("/flow", async (req, res) => {
  try {
    const { screen, data } = req.body;
    console.log("🔄 Flow screen:", screen);
    console.log("🔄 Flow data:", JSON.stringify(data, null, 2));

    const getProjects = async () => {
      const list = await Project.find({}).lean();
      return list.map((p) => ({ id: p._id.toString(), title: p.name }));
    };

    if (screen === "MAIN_MENU") {
      const choice = data?.menu_choice;

      const screenMap = {
        create_bill:      "CREATE_BILL",
        bill_status:      "BILL_STATUS",
        attendance:       "ATTENDANCE",
        work_update:      "WORK_UPDATE",
        daily_report:     "DAILY_REPORT",
        material_request: "MATERIAL_REQUEST",
        new_project:      "NEW_PROJECT",
        site_issue:       "SITE_ISSUE",
      };

      const nextScreen = screenMap[choice];
      if (!nextScreen) {
        return res.json({ version: "3.0", screen: "MAIN_MENU", data: {} });
      }

      const projects = await getProjects();
      const responseData = {};

      const needsProjects = [
        "CREATE_BILL", "ATTENDANCE", "WORK_UPDATE",
        "DAILY_REPORT", "MATERIAL_REQUEST", "SITE_ISSUE",
      ];
      if (needsProjects.includes(nextScreen)) {
        responseData.projects = projects;
      }

      if (nextScreen === "CREATE_BILL") {
        responseData.categories = [
          { id: "material",    title: "🧱 Material" },
          { id: "labour",      title: "👷 Labour" },
          { id: "machineries", title: "🚜 Machineries" },
          { id: "others",      title: "📦 Others" },
        ];
      }

      if (nextScreen === "BILL_STATUS") {
        const bills = await Bill.find({}).lean();
        responseData.bills = bills.map((b) => ({
          id: b._id.toString(),
          title: `${b.billId || b._id} — ${b.status || "In Progress"}`,
        }));
      }

      if (nextScreen === "MATERIAL_REQUEST") {
        responseData.material_types = [
          { id: "cement", title: "🪨 Cement" },
          { id: "sand",   title: "🏖️ Sand" },
          { id: "steel",  title: "🔩 Steel" },
          { id: "bricks", title: "🧱 Bricks" },
          { id: "paint",  title: "🎨 Paint" },
          { id: "pipes",  title: "🔧 Pipes" },
          { id: "other",  title: "📦 Other" },
        ];
      }

      if (nextScreen === "SITE_ISSUE") {
        responseData.issue_types = [
          { id: "safety",    title: "🚨 Safety Issue" },
          { id: "quality",   title: "🔍 Quality Issue" },
          { id: "delay",     title: "⏰ Work Delay" },
          { id: "equipment", title: "🔧 Equipment Problem" },
          { id: "material",  title: "🧱 Material Shortage" },
          { id: "labour",    title: "👷 Labour Issue" },
          { id: "other",     title: "📋 Other" },
        ];
        responseData.severity_levels = [
          { id: "low",      title: "🟢 Low" },
          { id: "medium",   title: "🟡 Medium" },
          { id: "high",     title: "🔴 High" },
          { id: "critical", title: "🚨 Critical" },
        ];
      }

      console.log(`✅ Routing to: ${nextScreen}`);
      return res.json({ version: "3.0", screen: nextScreen, data: responseData });
    }

    return res.json({ version: "3.0", screen: "MAIN_MENU", data: {} });

  } catch (err) {
    console.error("❌ Flow error:", err.message);
    console.error("❌ Flow full error:", err.response?.data);
    return res.status(500).json({ version: "3.0", screen: "MAIN_MENU", data: {} });
  }
});

module.exports = router;