/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ProfitDesk — WhatsApp Bot + Flow Handler
 *
 * Flow:  any msg → WELCOME (greeting + Create Bill button)
 *                → BILL_FORM (project, category, amount, vendor, remarks)
 *                → ADD_PHOTOS (camera/gallery, max 5)
 *                → ADD_DOCUMENTS (PDF/Excel/Word, max 5)
 *                → REVIEW (confirm / cancel)
 *                → SUCCESS
 *
 * Registered Users (loaded from DB):
 *   Kaviya      — +917904307757
 *   Sasi Kumar  — +917708420110
 *   Abinaya     — +919715558350
 *
 * Unregistered numbers → "not registered" message, no flow opened
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

const VERIFY_TOKEN     = process.env.WHATSAPP_VERIFY_TOKEN    || "profitdesk_verify_token";
const PHONE_NUMBER_ID  = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN     = process.env.WHATSAPP_ACCESS_TOKEN;
const FLOW_ID          = process.env.FLOW_ID;
const FLOW_PRIVATE_KEY = process.env.FLOW_PRIVATE_KEY;
const GRAPH_URL        = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}`;

console.log("\n📱 ProfitDesk WhatsApp Bot Started");
console.log(`   PHONE_NUMBER_ID:  ${PHONE_NUMBER_ID  ? "✅" : "❌ MISSING"}`);
console.log(`   ACCESS_TOKEN:     ${ACCESS_TOKEN     ? "✅" : "❌ MISSING"}`);
console.log(`   FLOW_ID:          ${FLOW_ID          || "❌ MISSING"}`);
console.log(`   FLOW_PRIVATE_KEY: ${FLOW_PRIVATE_KEY ? "✅" : "❌ MISSING"}\n`);

// ═══════════════════════════════════════════════════════════════════════════════
// 📝 CATEGORY MAP  (Flow radio id → Bill model enum)
// ═══════════════════════════════════════════════════════════════════════════════

const CATEGORY_MAP = {
  Material:  "Material",
  Manpower:  "Labour",
  Equipment: "Machineries",
  Others:    "Others",
};

// ═══════════════════════════════════════════════════════════════════════════════
// 📞 PHONE UTILS
// ═══════════════════════════════════════════════════════════════════════════════

function toE164Indian(phone) {
  if (!phone) return null;
  const d = String(phone).replace(/\D/g, "");
  if (d.length === 10)                         return `+91${d}`;
  if (d.length === 12 && d.startsWith("91"))  return `+${d}`;
  if (d.length === 13 && d.startsWith("910")) return `+91${d.slice(3)}`;
  return `+${d}`;
}

function last10(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 💾 IN-MEMORY SESSION STORE
// ═══════════════════════════════════════════════════════════════════════════════

const sessions = {};

function getSession(from) {
  if (!sessions[from]) {
    sessions[from] = {
      user:     null,
      projects: [],
      bill: {
        project_id:           null,
        project_name:         null,
        bill_type:            null,
        bill_amount:          null,
        vendor_name:          "",
        remarks:              "",
        photo_attachments:    [],
        document_attachments: [],
      },
    };
  }
  return sessions[from];
}

function clearSession(from) {
  delete sessions[from];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔐 FLOW ENCRYPTION / DECRYPTION
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
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return { parsed: JSON.parse(decrypted.toString("utf8")), aesKey: decryptedAesKey, iv };
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
  const tail10     = String(whatsappNumber).replace(/\D/g, "").slice(-10);
  const candidates = [`+91${tail10}`, `91${tail10}`, tail10, `0${tail10}`];

  // Fast indexed lookup first
  let user = await User.findOne(
    { mobile: { $in: candidates }, isActive: true },
    null,
    { lean: false }
  ).populate("companies");

  if (user) {
    console.log(`✅ User found: "${user.name}" (${user.mobile})`);
    return user;
  }

  // Fallback: full collection scan (handles odd formats)
  const all     = await User.find({ isActive: true }).populate("companies");
  const matched = all.find((u) => last10(u.mobile) === tail10);

  if (matched) {
    console.log(`✅ User found (scan): "${matched.name}" — normalising mobile`);
    // Auto-heal to E164 in background
    User.updateOne(
      { _id: matched._id },
      { $set: { mobile: toE164Indian(matched.mobile) } }
    ).catch((e) => console.warn("⚠️  Auto-heal failed:", e.message));
    return matched;
  }

  console.warn(`❌ No user found for: ${whatsappNumber} (tail: ${tail10})`);
  return null;
}

async function loadProjects(user) {
  const companyIds = user.companies.map((c) => c._id);
  const rows = await Project.find({
    company:  { $in: companyIds },
    isActive: true,
  })
    .populate("company")
    .lean();

  return rows.map((p) => ({
    id:    p._id.toString(),
    title: p.name + (p.location ? ` — ${p.location}` : ""),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📤 WHATSAPP SEND HELPERS
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
    console.log(`📤 Text sent to ${to}`);
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
            // This text appears in the WhatsApp chat BEFORE the flow opens
            text: `Hello *${userName}* 👋\nWelcome to *ProfitDesk*!\nTap below to create a new bill.`,
          },
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              flow_id:              FLOW_ID,
              flow_cta:             "📋 Create Bill",
              flow_token:           to,   // used as identifier in flow handler
              // Flow opens on WELCOME screen — INIT action fires automatically
            },
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Flow message sent to ${to} (${userName})`);
  } catch (err) {
    console.error("❌ sendFlowMessage error:", err.response?.data || err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🤖 INCOMING MESSAGE HANDLER
//
//  Logic:
//    1. Any message type arrives
//    2. Look up sender in DB
//    3. If NOT found  → send "not registered" text, stop
//    4. If found      → pre-load session → send Flow (opens on WELCOME screen)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleIncomingMessage(from, message) {
  console.log(`\n📨 Incoming | From: ${from} | Type: ${message.type}`);

  // ── Only handle text messages (ignore image / audio / sticker / etc.) ──────
  if (message.type !== "text") {
    console.log(`   Ignored non-text message type: ${message.type}`);
    return;
  }

  // ── Look up user in DB ──────────────────────────────────────────────────────
  const user = await findUserByPhone(from);

  if (!user) {
    // Unregistered number → inform and stop
    await sendText(
      from,
      "❌ Your number is not registered in ProfitDesk.\n\nPlease contact your admin to get access."
    );
    console.log(`🚫 Unregistered number blocked: ${from}`);
    return;
  }

  // ── Registered user → pre-load session so WELCOME/INIT is instant ──────────
  const session    = getSession(from);
  session.user     = user;
  session.projects = await loadProjects(user);

  console.log(`✅ Registered user: ${user.name} | Projects loaded: ${session.projects.length}`);

  // ── Send Flow — opens on WELCOME screen, INIT fires automatically ───────────
  await sendFlowMessage(from, user.name);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔄 FLOW ACTION HANDLER
//
//  Screen flow:
//    INIT        → WELCOME
//    WELCOME     → BILL_FORM     (data_exchange: action=go_to_bill_form)
//    BILL_FORM   → ADD_PHOTOS    (data_exchange: project, category, amount...)
//    ADD_PHOTOS  → ADD_DOCUMENTS (data_exchange: photo_attachments)
//    ADD_DOCUMENTS → REVIEW      (data_exchange: document_attachments)
//    REVIEW      → SUCCESS       (data_exchange: confirmation=confirm)
//                → BILL_FORM     (data_exchange: confirmation=cancel)
// ═══════════════════════════════════════════════════════════════════════════════

async function handleFlowAction(from, action, screen, data, session) {
  console.log(`🔄 Flow | From: ${from} | Screen: ${screen} | Action: ${action}`);

  // ────────────────────────────────────────────────────────────────────────────
  // INIT — Flow opened, show WELCOME screen
  // ────────────────────────────────────────────────────────────────────────────
  if (action === "INIT") {
    // Re-fetch in case server restarted and session is empty
    let user     = session.user;
    let projects = session.projects;

    if (!user) {
      user = await findUserByPhone(from);
      if (!user) {
        // Fallback — should not happen (handleIncomingMessage blocks unregistered)
        return {
          version: "3.0",
          screen:  "WELCOME",
          data:    { user_name: "there" },
        };
      }
      projects         = await loadProjects(user);
      session.user     = user;
      session.projects = projects;
    }

    console.log(`✅ INIT — user: ${user.name} | projects: ${projects.length}`);

    return {
      version: "3.0",
      screen:  "WELCOME",
      data:    { user_name: user.name },
    };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // DATA EXCHANGE
  // ────────────────────────────────────────────────────────────────────────────
  if (action === "data_exchange") {

    // ── WELCOME → BILL_FORM ───────────────────────────────────────────────────
    if (screen === "WELCOME") {
      // User tapped "Create Bill" on welcome screen
      // Ensure projects are loaded (edge case: session cleared mid-flow)
      if (!session.projects || session.projects.length === 0) {
        const user = session.user || (await findUserByPhone(from));
        if (user) {
          session.user     = user;
          session.projects = await loadProjects(user);
        }
      }

      console.log(`➡️  WELCOME → BILL_FORM | Projects: ${session.projects?.length || 0}`);

      return {
        version: "3.0",
        screen:  "BILL_FORM",
        data: {
          user_name:      session.user?.name || "there",
          projects:       session.projects   || [],
          project_error:  "",
          category_error: "",
          amount_error:   "",
        },
      };
    }

    // ── BILL_FORM → ADD_PHOTOS ────────────────────────────────────────────────
    if (screen === "BILL_FORM") {
      const projectId = data?.selected_project;
      const billType  = data?.bill_type;
      const amount    = parseFloat(String(data?.bill_amount || "").replace(/,/g, ""));

      // Validate
      const projectError  = !projectId                            ? "Please select a project."    : "";
      const categoryError = !billType || !CATEGORY_MAP[billType] ? "Please select a category."   : "";
      const amountError   = isNaN(amount) || amount <= 0         ? "Please enter a valid amount." : "";

      if (projectError || categoryError || amountError) {
        return {
          version: "3.0",
          screen:  "BILL_FORM",
          data: {
            user_name:      session.user?.name || "there",
            projects:       session.projects   || [],
            project_error:  projectError,
            category_error: categoryError,
            amount_error:   amountError,
          },
        };
      }

      // Save bill form data to session
      const project = session.projects.find((p) => p.id === projectId);
      session.bill.project_id   = projectId;
      session.bill.project_name = project?.title || projectId;
      session.bill.bill_type    = CATEGORY_MAP[billType];
      session.bill.bill_amount  = amount;
      session.bill.vendor_name  = data?.vendor_name?.trim() || "";
      session.bill.remarks      = data?.remarks?.trim()     || "";

      console.log(
        `📝 Bill form saved | Project: ${session.bill.project_name}` +
        ` | Type: ${session.bill.bill_type} | ₹${amount}`
      );

      return {
        version: "3.0",
        screen:  "ADD_PHOTOS",
        data:    { error_message: "" },
      };
    }

    // ── ADD_PHOTOS → ADD_DOCUMENTS ────────────────────────────────────────────
    if (screen === "ADD_PHOTOS") {
      const photos = data?.photo_attachments || [];
      session.bill.photo_attachments = Array.isArray(photos) ? photos : [];

      console.log(`📸 Photos saved: ${session.bill.photo_attachments.length}`);

      return {
        version: "3.0",
        screen:  "ADD_DOCUMENTS",
        data:    { error_message: "" },
      };
    }

    // ── ADD_DOCUMENTS → REVIEW ────────────────────────────────────────────────
    if (screen === "ADD_DOCUMENTS") {
      const docs = data?.document_attachments || [];
      session.bill.document_attachments = Array.isArray(docs) ? docs : [];

      const totalFiles =
        session.bill.photo_attachments.length +
        session.bill.document_attachments.length;

      console.log(
        `📄 Docs saved: ${session.bill.document_attachments.length}` +
        ` | Total files: ${totalFiles}`
      );

      const attachmentText =
        totalFiles === 0
          ? "No files"
          : `${totalFiles} file${totalFiles > 1 ? "s" : ""}`;

      return {
        version: "3.0",
        screen:  "REVIEW",
        data: {
          user_name:         session.user?.name                          || "—",
          project_name:      session.bill.project_name                   || "—",
          bill_type:         session.bill.bill_type                      || "—",
          bill_amount:       session.bill.bill_amount.toLocaleString("en-IN"),
          vendor_name:       session.bill.vendor_name                    || "Not specified",
          attachments_count: attachmentText,
          remarks:           session.bill.remarks                        || "None",
          error_message:     "",
        },
      };
    }

    // ── REVIEW → SUCCESS or back to BILL_FORM ────────────────────────────────
    if (screen === "REVIEW") {
      const confirmation = data?.confirmation;

      const allFiles   = [
        ...session.bill.photo_attachments,
        ...session.bill.document_attachments,
      ];
      const totalFiles = allFiles.length;
      const attachText =
        totalFiles === 0
          ? "No files"
          : `${totalFiles} file${totalFiles > 1 ? "s" : ""}`;

      // ── No selection made ───────────────────────────────────────────────────
      if (!confirmation) {
        return {
          version: "3.0",
          screen:  "REVIEW",
          data: {
            user_name:         session.user?.name                              || "—",
            project_name:      session.bill.project_name                       || "—",
            bill_type:         session.bill.bill_type                          || "—",
            bill_amount:       session.bill.bill_amount?.toLocaleString("en-IN") || "0",
            vendor_name:       session.bill.vendor_name                        || "Not specified",
            attachments_count: attachText,
            remarks:           session.bill.remarks                            || "None",
            error_message:     "Please confirm or cancel to proceed.",
          },
        };
      }

      // ── CANCEL ──────────────────────────────────────────────────────────────
      if (confirmation === "cancel") {
        const userName = session.user?.name || "there";
        clearSession(from);

        // Notify in WhatsApp chat
        sendText(
          from,
          "🚫 Bill cancelled. No entry was saved.\n\n_Send any message to create a new bill._"
        ).catch((e) => console.error("❌ sendText (cancel):", e.message));

        // Return to BILL_FORM (fresh)
        return {
          version: "3.0",
          screen:  "BILL_FORM",
          data: {
            user_name:      userName,
            projects:       [],          // empty — user will need to restart
            project_error:  "",
            category_error: "",
            amount_error:   "",
          },
        };
      }

      // ── CONFIRM → Save Bill to DB ───────────────────────────────────────────
      if (confirmation === "confirm") {
        try {
          // Generate sequential Bill ID: B/MM/YYYY-00001
          const billCount = await Bill.countDocuments({});
          const now       = new Date();
          const mm        = String(now.getMonth() + 1).padStart(2, "0");
          const yyyy      = now.getFullYear();
          const seq       = String(billCount + 1).padStart(5, "0");
          const billId    = `B/${mm}/${yyyy}-${seq}`;

          const newBill = new Bill({
            billId,
            date:        now,
            project:     session.bill.project_id,
            company:     session.user.companies[0]._id,
            engineer:    session.user._id,
            category:    session.bill.bill_type,
            amount:      session.bill.bill_amount,
            vendorName:  session.bill.vendor_name,
            remarks:     session.bill.remarks,
            status:      "In Progress",
            attachments: allFiles,
          });

          await newBill.save();

          const fmt         = session.bill.bill_amount.toLocaleString("en-IN");
          const projectName = session.bill.project_name;
          const billType    = session.bill.bill_type;
          const vendor      = session.bill.vendor_name || "—";
          const fileCount   = allFiles.length;

          console.log(`✅ Bill saved: ${billId} | ${billType} | ₹${fmt} | Files: ${fileCount}`);
          clearSession(from);

          // Send WhatsApp chat confirmation (outside the flow)
          sendText(
            from,
            `✅ *Bill Created Successfully!*\n\n` +
            `📝 Bill ID:   *${billId}*\n` +
            `🏗️ Project:  ${projectName}\n` +
            `📋 Category: ${billType}\n` +
            `💰 Amount:   ₹${fmt}\n` +
            `🏪 Vendor:   ${vendor}\n` +
            `📎 Files:    ${fileCount > 0 ? `${fileCount} attached` : "None"}\n` +
            `📌 Status:   In Progress\n\n` +
            `_Send any message to create another bill._`
          ).catch((e) => console.error("❌ sendText (confirm):", e.message));

          // Show SUCCESS screen inside the flow
          return {
            version: "3.0",
            screen:  "SUCCESS",
            data: {
              bill_id:           billId,
              project_name:      projectName,
              bill_type:         billType,
              bill_amount:       fmt,
              vendor_name:       vendor,
              attachments_count:
                fileCount > 0
                  ? `${fileCount} file${fileCount > 1 ? "s" : ""}`
                  : "No files",
            },
          };

        } catch (err) {
          // DB save failed — show error on REVIEW screen
          console.error("❌ Bill save error:", err.message);

          return {
            version: "3.0",
            screen:  "REVIEW",
            data: {
              user_name:         session.user?.name                              || "—",
              project_name:      session.bill.project_name                       || "—",
              bill_type:         session.bill.bill_type                          || "—",
              bill_amount:       session.bill.bill_amount?.toLocaleString("en-IN") || "0",
              vendor_name:       session.bill.vendor_name                        || "Not specified",
              attachments_count: attachText,
              remarks:           session.bill.remarks                            || "None",
              error_message:     `❌ Save failed: ${err.message}`,
            },
          };
        }
      }
    }
  }

  // ── FALLBACK — unknown screen/action ────────────────────────────────────────
  console.warn(`⚠️  Unhandled | screen: ${screen} | action: ${action}`);
  return {
    version: "3.0",
    screen:  "WELCOME",
    data:    { user_name: session.user?.name || "there" },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📨 WEBHOOK ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── GET / — Webhook verification (Meta challenge) ─────────────────────────────
router.get("/", (req, res) => {
  const {
    "hub.mode":          mode,
    "hub.verify_token":  token,
    "hub.challenge":     challenge,
  } = req.query;

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  console.warn("❌ Webhook verification failed");
  res.sendStatus(403);
});

// ── GET /debug-users — List all users with mobile numbers ────────────────────
router.get("/debug-users", async (req, res) => {
  try {
    const users = await User.find({}).select("name mobile isActive").lean();
    res.json({ count: users.length, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /normalize-mobiles — One-time fix: convert all mobiles to E164 ───────
router.get("/normalize-mobiles", async (req, res) => {
  try {
    const users  = await User.find({});
    let updated  = 0;
    const report = [];

    for (const u of users) {
      const normalised = toE164Indian(u.mobile);
      if (normalised && normalised !== u.mobile) {
        report.push({ name: u.name, before: u.mobile, after: normalised });
        u.mobile = normalised;
        await u.save();
        updated++;
      }
    }
    res.json({ updated, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST / — Incoming WhatsApp messages ──────────────────────────────────────
router.post("/", (req, res) => {
  res.sendStatus(200); // Acknowledge immediately to Meta (must be <5s)

  try {
    const value   = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return;

    const message = value.messages[0];
    const from    = message?.from;
    if (!from || !message) return;

    handleIncomingMessage(from, message).catch((e) =>
      console.error("❌ handleIncomingMessage crashed:", e.message)
    );
  } catch (err) {
    console.error("❌ Webhook POST parse error:", err.message);
  }
});

// ── POST /flow — WhatsApp Flow data exchange endpoint ────────────────────────
router.post("/flow", async (req, res) => {
  console.log(`\n📨 Flow Request received`);

  try {
    if (!FLOW_PRIVATE_KEY) {
      console.error("❌ FLOW_PRIVATE_KEY not set");
      return res.status(500).json({ error: "Server not configured — missing FLOW_PRIVATE_KEY" });
    }

    const decrypted = decryptFlowRequest(req.body);
    if (!decrypted) {
      return res.status(400).json({ error: "Decryption failed" });
    }

    const { action, screen, flow_token, data } = decrypted.parsed;

    // Health check ping from Meta — just reply active
    if (action === "ping") {
      const enc = encryptFlowResponse(
        { version: "3.0", data: { status: "active" } },
        decrypted.aesKey,
        decrypted.iv
      );
      res.set("Content-Type", "text/plain");
      return res.status(200).send(enc);
    }

    const from = flow_token;
    if (!from) {
      console.error("❌ No flow_token (phone number) in request");
      return res.status(400).json({ error: "Missing flow_token" });
    }

    console.log(`   From: ${from} | Action: ${action} | Screen: ${screen}`);

    const session     = getSession(from);
    const responseObj = await handleFlowAction(from, action, screen, data, session);
    const encrypted   = encryptFlowResponse(responseObj, decrypted.aesKey, decrypted.iv);

    res.set("Content-Type", "text/plain");
    return res.status(200).send(encrypted);

  } catch (err) {
    console.error("❌ Flow endpoint error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;