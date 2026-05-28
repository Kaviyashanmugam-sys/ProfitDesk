/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ProfitDesk WhatsApp Bot + Flow Handler [MULTI-FILE SUPPORT]
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const express = require("express");
const router  = express.Router();
const axios   = require("axios");
const crypto  = require("crypto");

const Project = require("../models/Project");
const Bill    = require("../models/Bill");
const User    = require("../models/User");

// ═══════════════════════════════════════════════════════════════════════════════
// 🔑 CONFIG
// ═══════════════════════════════════════════════════════════════════════════════

const VERIFY_TOKEN     = process.env.WHATSAPP_VERIFY_TOKEN || "profitdesk_verify_token";
const PHONE_NUMBER_ID  = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN     = process.env.WHATSAPP_ACCESS_TOKEN;
const FLOW_ID          = process.env.FLOW_ID;
const FLOW_PRIVATE_KEY = process.env.FLOW_PRIVATE_KEY;
const GRAPH_URL        = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}`;

console.log("\n📱 ProfitDesk Bot Started");
console.log(`   PHONE_NUMBER_ID:  ${PHONE_NUMBER_ID  ? "✅" : "❌"}`);
console.log(`   ACCESS_TOKEN:     ${ACCESS_TOKEN     ? "✅" : "❌"}`);
console.log(`   FLOW_ID:          ${FLOW_ID          || "❌"}`);
console.log(`   FLOW_PRIVATE_KEY: ${FLOW_PRIVATE_KEY ? "✅" : "❌"}\n`);

// ═══════════════════════════════════════════════════════════════════════════════
// 📝 CATEGORY MAPPING (Flow UI → Bill Model Enum)
// ═══════════════════════════════════════════════════════════════════════════════

const CATEGORY_MAP = {
  "Material":    "Material",
  "Manpower":    "Labour",
  "Equipment":   "Machineries",
  "Others":      "Others",
};

// ═══════════════════════════════════════════════════════════════════════════════
// 📞 PHONE UTILS
// ═══════════════════════════════════════════════════════════════════════════════

function toE164Indian(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length === 10)                              return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91"))  return `+${digits}`;
  if (digits.length === 13 && digits.startsWith("910")) return `+91${digits.slice(3)}`;
  return `+${digits}`;
}

function last10(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 💾 SESSION STORE
// ═══════════════════════════════════════════════════════════════════════════════

const sessions = {};

function getSession(from) {
  if (!sessions[from]) {
    sessions[from] = {
      user:     null,
      projects: [],
      bill: {
        project_id:   null,
        project_name: null,
        bill_type:    null,
        photo_attachments: [],      // ← Added: photos/images
        document_attachments: [],   // ← Added: PDFs, Excel, Word, etc.
        bill_amount:  null,
        remarks:      "",
      },
    };
  }
  return sessions[from];
}

function clearSession(from) {
  delete sessions[from];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔐 ENCRYPTION / DECRYPTION
// ═══════════════════════════════════════════════════════════════════════════════

function decryptFlowRequest(body) {
  try {
    const encryptedAesKey = Buffer.from(body.encrypted_aes_key, "base64");
    const privateKeyObj   = crypto.createPrivateKey(FLOW_PRIVATE_KEY);

    const decryptedAesKey = crypto.privateDecrypt(
      {
        key:      privateKeyObj,
        padding:  crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      encryptedAesKey
    );

    const iv         = Buffer.from(body.initial_vector, "base64");
    const encrypted  = Buffer.from(body.encrypted_flow_data, "base64");
    const TAG_LENGTH = 16;
    const tag        = encrypted.slice(-TAG_LENGTH);
    const ciphertext = encrypted.slice(0, -TAG_LENGTH);

    const decipher = crypto.createDecipheriv("aes-128-gcm", decryptedAesKey, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return {
      parsed: JSON.parse(decrypted.toString("utf8")),
      aesKey: decryptedAesKey,
      iv,
    };
  } catch (err) {
    console.error("❌ Decryption error:", err.message);
    return null;
  }
}

function encryptFlowResponse(responseObj, aesKey, iv) {
  const flippedIv = Buffer.from(iv).map((b) => ~b & 0xff);
  const cipher    = crypto.createCipheriv("aes-128-gcm", aesKey, flippedIv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(responseObj), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔍 DB HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function findUserByPhone(whatsappNumber) {
  const raw    = String(whatsappNumber).replace(/\D/g, "");
  const tail10 = raw.slice(-10);

  console.log(`🔍 Looking up user | WA#: ${whatsappNumber} | Last-10: ${tail10}`);

  const candidates = [
    `+91${tail10}`,
    `91${tail10}`,
    tail10,
    `0${tail10}`,
  ];

  const user = await User.findOne(
    { mobile: { $in: candidates }, isActive: true },
    null,
    { lean: false }
  ).populate("companies");

  if (user) {
    console.log(`✅ User found (indexed): "${user.name}" | Stored: ${user.mobile}`);
    return user;
  }

  console.log(`⚠️  Indexed lookup missed — trying last-10 full-scan…`);

  const allUsers = await User.find({ isActive: true }).populate("companies");
  const matched  = allUsers.find((u) => last10(u.mobile) === tail10);

  if (matched) {
    console.log(`✅ User found (scan): "${matched.name}" | Stored: ${matched.mobile}`);
    try {
      await User.updateOne(
        { _id: matched._id },
        { $set: { mobile: toE164Indian(matched.mobile) } }
      );
      console.log(`🔧 Auto-normalized → ${toE164Indian(matched.mobile)}`);
    } catch (healErr) {
      console.warn("⚠️  Auto-heal failed:", healErr.message);
    }
    return matched;
  }

  console.warn(`❌ No user found for: ${whatsappNumber}`);
  return null;
}

async function loadProjects(user) {
  const projects = await Project.find({
    company:  { $in: user.companies.map((c) => c._id) },
    isActive: true,
  })
    .populate("company")
    .lean();

  return projects.map((p) => ({
    id:    p._id.toString(),
    title: `${p.name}${p.location ? ` — ${p.location}` : ""}`,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📤 SEND HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function sendText(to, text) {
  try {
    await axios.post(
      `${GRAPH_URL}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
  } catch (err) {
    console.error("❌ sendText error:", err.response?.data || err.message);
  }
}

async function sendFlowMessage(to, userName) {
  try {
    await axios.post(
      `${GRAPH_URL}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "flow",
          body: {
            text: `Hello *${userName}* 👋\nTap below to open ProfitDesk and create a bill.`,
          },
          action: {
            name:       "flow",
            parameters: {
              flow_message_version: "3",
              flow_id:              FLOW_ID,
              flow_cta:             "Open ProfitDesk",
              flow_token:           to,
            },
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Flow message sent to ${to}`);
  } catch (err) {
    console.error("❌ sendFlow error:", err.response?.data || err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🤖 INCOMING MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleIncomingMessage(from, message) {
  console.log(`\n📨 Message from ${from} | Type: ${message.type}`);

  if (message.type !== "text") return;

  const user = await findUserByPhone(from);

  if (!user) {
    await sendText(
      from,
      "❌ Your number is not registered in ProfitDesk.\nPlease contact your admin."
    );
    return;
  }

  const session    = getSession(from);
  session.user     = user;
  session.projects = await loadProjects(user);

  await sendFlowMessage(from, user.name);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔄 FLOW SCREEN HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

async function handleFlowAction(from, action, screen, data, session) {
  console.log(`🔄 Screen: ${screen} | Action: ${action}`);

  // ── INIT ────────────────────────────────────────────────────────────────────
  if (action === "INIT") {
    if (!session.user) {
      session.user = await findUserByPhone(from);
      if (session.user) {
        session.projects = await loadProjects(session.user);
      }
    }
    return {
      version: "3.0",
      screen:  "WELCOME",
      data: { user_name: session.user?.name || "there" },
    };
  }

  // ── DATA EXCHANGE ────────────────────────────────────────────────────────────
  if (action === "data_exchange") {

    // ── WELCOME ──────────────────────────────────────────────────────────────
    if (screen === "WELCOME") {
      if (!session.projects?.length) {
        session.projects = await loadProjects(session.user);
      }
      if (!session.projects.length) {
        return {
          version: "3.0",
          screen:  "WELCOME",
          data: { user_name: session.user?.name || "there" },
        };
      }
      return {
        version: "3.0",
        screen:  "PROJECT_SELECTION",
        data: { projects: session.projects, error_message: "" },
      };
    }

    // ── PROJECT_SELECTION ────────────────────────────────────────────────────
    if (screen === "PROJECT_SELECTION") {
      const projectId = data?.selected_project;
      if (!projectId) {
        return {
          version: "3.0",
          screen:  "PROJECT_SELECTION",
          data: { projects: session.projects, error_message: "Please select a project." },
        };
      }
      const project             = session.projects.find((p) => p.id === projectId);
      session.bill.project_id   = projectId;
      session.bill.project_name = project?.title || projectId;
      return {
        version: "3.0",
        screen:  "BILL_TYPE",
        data: { error_message: "" },
      };
    }

    // ── BILL_TYPE ────────────────────────────────────────────────────────────
    if (screen === "BILL_TYPE") {
      const billType = data?.bill_type;
      const valid    = ["Material", "Manpower", "Equipment", "Others"];
      
      if (!billType || !valid.includes(billType)) {
        return {
          version: "3.0",
          screen:  "BILL_TYPE",
          data: { error_message: "Please select a bill type." },
        };
      }
      
      session.bill.bill_type = CATEGORY_MAP[billType];
      console.log(`📝 Mapped: "${billType}" → "${session.bill.bill_type}"`);
      
      return {
        version: "3.0",
        screen:  "ADD_ATTACHMENT",
        data: { error_message: "" },
      };
    }

    // ── ADD_PHOTOS ────────────────────────────────────────────────────────────
    // ✅ UPDATED: First attachment screen for photos only
    if (screen === "ADD_PHOTOS") {
      const photoAttachments = data?.photo_attachments || [];
      session.bill.photo_attachments = Array.isArray(photoAttachments) ? photoAttachments : [];
      
      console.log(`📸 Photos uploaded: ${session.bill.photo_attachments.length}`);
      
      return {
        version: "3.0",
        screen:  "ADD_DOCUMENTS",
        data: { error_message: "" },
      };
    }

    // ── ADD_DOCUMENTS ──────────────────────────────────────────────────────────
    // ✅ UPDATED: Second attachment screen for documents
    if (screen === "ADD_DOCUMENTS") {
      const docAttachments = data?.document_attachments || [];
      session.bill.document_attachments = Array.isArray(docAttachments) ? docAttachments : [];
      
      const totalFiles = session.bill.photo_attachments.length + session.bill.document_attachments.length;
      console.log(`📄 Documents uploaded: ${session.bill.document_attachments.length} | Total: ${totalFiles}`);
      
      return {
        version: "3.0",
        screen:  "ENTER_AMOUNT",
        data: { error_message: "" },
      };
    }

    // ── ENTER_AMOUNT ─────────────────────────────────────────────────────────
    if (screen === "ENTER_AMOUNT") {
      const amount = parseFloat(String(data?.bill_amount || "").replace(/,/g, ""));
      if (isNaN(amount) || amount <= 0) {
        return {
          version: "3.0",
          screen:  "ENTER_AMOUNT",
          data: { error_message: "Please enter a valid amount." },
        };
      }
      session.bill.bill_amount = amount;
      session.bill.remarks     = data?.remarks?.trim() || "";
      
      const totalFiles = session.bill.photo_attachments.length + session.bill.document_attachments.length;
      const attachmentText = totalFiles === 0 ? "No files" : `${totalFiles} file${totalFiles > 1 ? "s" : ""}`;
      
      return {
        version: "3.0",
        screen:  "REVIEW",
        data: {
          user_name:     session.user?.name    || "—",
          project_name:  session.bill.project_name,
          bill_type:     session.bill.bill_type,
          bill_amount:   amount.toLocaleString("en-IN"),
          attachments_count: attachmentText,
          remarks:       session.bill.remarks  || "None",
          error_message: "",
        },
      };
    }

    // ── REVIEW ───────────────────────────────────────────────────────────────
    if (screen === "REVIEW") {
      const confirmation = data?.confirmation;
      
      const totalFiles = session.bill.photo_attachments.length + session.bill.document_attachments.length;
      const attachmentText = totalFiles === 0 ? "No files" : `${totalFiles} file${totalFiles > 1 ? "s" : ""}`;

      if (!confirmation) {
        return {
          version: "3.0",
          screen:  "REVIEW",
          data: {
            user_name:     session.user?.name    || "—",
            project_name:  session.bill.project_name,
            bill_type:     session.bill.bill_type,
            bill_amount:   session.bill.bill_amount.toLocaleString("en-IN"),
            attachments_count: attachmentText,
            remarks:       session.bill.remarks  || "None",
            error_message: "Please confirm or cancel.",
          },
        };
      }

      if (confirmation === "cancel") {
        const userName = session.user?.name || "there";
        clearSession(from);
        return {
          version: "3.0",
          screen:  "WELCOME",
          data: { user_name: userName },
        };
      }

      if (confirmation === "confirm") {
        try {
          const billCount = await Bill.countDocuments({});
          const now       = new Date();
          const billId    = `B/${String(now.getMonth() + 1).padStart(2, "0")}/${now.getFullYear()}-${String(billCount + 1).padStart(5, "0")}`;

          // ✅ Merge all attachments
          const allAttachments = [
            ...session.bill.photo_attachments,
            ...session.bill.document_attachments
          ];

          const newBill = new Bill({
            billId,
            date:        now,
            project:     session.bill.project_id,
            company:     session.user.companies[0]._id,
            engineer:    session.user._id,
            category:    session.bill.bill_type,
            amount:      session.bill.bill_amount,
            remarks:     session.bill.remarks,
            status:      "In Progress",
            attachments: allAttachments,
          });

          await newBill.save();
          console.log(`✅ Bill saved: ${billId} | Category: ${session.bill.bill_type} | Files: ${allAttachments.length}`);

          const formattedAmount = session.bill.bill_amount.toLocaleString("en-IN");
          const projectName     = session.bill.project_name;
          const billType        = session.bill.bill_type;
          const fileCount       = allAttachments.length;

          clearSession(from);

          // Fire-and-forget
          sendText(
            from,
            `✅ *Bill Created!*\n\n` +
            `📝 Bill ID: *${billId}*\n` +
            `🏗️ Project: ${projectName}\n` +
            `📋 Type: ${billType}\n` +
            `💰 Amount: ₹${formattedAmount}\n` +
            `📎 Files: ${fileCount} attached\n` +
            `📌 Status: In Progress\n\n` +
            `_Send any message to create another bill._`
          ).catch((e) => console.error("❌ sendText after confirm:", e.message));

          return {
            version: "3.0",
            screen:  "SUCCESS",
            data: {
              bill_id:      billId,
              project_name: projectName,
              bill_type:    billType,
              bill_amount:  formattedAmount,
              attachments_count: fileCount > 0 ? `${fileCount} file${fileCount > 1 ? "s" : ""}` : "No files",
            },
          };
        } catch (err) {
          console.error("❌ Bill save error:", err.message);
          
          const totalFiles = session.bill.photo_attachments.length + session.bill.document_attachments.length;
          const attachmentText = totalFiles === 0 ? "No files" : `${totalFiles} file${totalFiles > 1 ? "s" : ""}`;
          
          return {
            version: "3.0",
            screen:  "REVIEW",
            data: {
              user_name:     session.user?.name    || "—",
              project_name:  session.bill.project_name,
              bill_type:     session.bill.bill_type,
              bill_amount:   session.bill.bill_amount.toLocaleString("en-IN"),
              attachments_count: attachmentText,
              remarks:       session.bill.remarks  || "None",
              error_message: `Failed to save: ${err.message}`,
            },
          };
        }
      }
    }
  }

  // ── UNKNOWN ─────────────────────────────────────────────────────────────────
  console.warn(`⚠️  Unhandled: screen=${screen} | action=${action}`);
  return {
    version: "3.0",
    screen:  "WELCOME",
    data: { user_name: session.user?.name || "there" },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📨 WEBHOOK ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET /webhook — Meta verification ─────────────────────────────────────────
router.get("/", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.warn("❌ Webhook verification failed");
  res.sendStatus(403);
});

// ── GET /webhook/debug-users ────────────────────────────────────────────────
router.get("/debug-users", async (req, res) => {
  try {
    const users = await User.find({}).select("name mobile isActive").lean();
    res.json({ count: users.length, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /webhook/normalize-mobiles ──────────────────────────────────────────
router.get("/normalize-mobiles", async (req, res) => {
  try {
    const users   = await User.find({});
    let   updated = 0;
    const report  = [];
    for (const u of users) {
      const normalized = toE164Indian(u.mobile);
      if (normalized && normalized !== u.mobile) {
        report.push({ name: u.name, before: u.mobile, after: normalized });
        u.mobile = normalized;
        await u.save();
        updated++;
      }
    }
    console.log(`🔧 Normalized ${updated} mobile numbers`);
    res.json({ updated, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /webhook — incoming WhatsApp messages ────────────────────────────────
router.post("/", (req, res) => {
  res.sendStatus(200);
  try {
    const entry   = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    if (!value?.messages) return;
    const message = value.messages[0];
    const from    = message?.from;
    if (!from || !message) return;
    handleIncomingMessage(from, message).catch((err) =>
      console.error("❌ handleIncomingMessage error:", err.message)
    );
  } catch (err) {
    console.error("❌ Webhook parse error:", err.message);
  }
});

// ── POST /webhook/flow — encrypted Flow data exchange ─────────────────────────
router.post("/flow", async (req, res) => {
  console.log(`\n📨 Flow Request`);
  try {
    if (!FLOW_PRIVATE_KEY) {
      console.error("❌ FLOW_PRIVATE_KEY not set");
      return res.status(500).json({ error: "Server not configured" });
    }

    const decrypted = decryptFlowRequest(req.body);
    if (!decrypted) {
      return res.status(400).json({ error: "Decryption failed" });
    }

    const { action, screen, flow_token, data } = decrypted.parsed;

    // ── Ping ──────────────────────────────────────────────────────────────────
    if (action === "ping") {
      console.log("🏓 Ping — responding active");
      const encrypted = encryptFlowResponse(
        { version: "3.0", data: { status: "active" } },
        decrypted.aesKey,
        decrypted.iv
      );
      res.set("Content-Type", "text/plain");
      return res.status(200).send(encrypted);
    }

    const from = flow_token;
    if (!from) {
      console.error("❌ No phone number in flow_token");
      return res.status(400).json({ error: "No phone number" });
    }

    console.log(`   From: ${from} | Action: ${action} | Screen: ${screen}`);

    const session     = getSession(from);
    const responseObj = await handleFlowAction(from, action, screen, data, session);
    const encrypted   = encryptFlowResponse(responseObj, decrypted.aesKey, decrypted.iv);

    res.set("Content-Type", "text/plain");
    return res.status(200).send(encrypted);

  } catch (err) {
    console.error("❌ Flow error:", err.message);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;