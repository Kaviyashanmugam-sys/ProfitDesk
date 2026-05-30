/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ProfitDesk — WhatsApp Bot + Flow Handler
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

const SESSION_TTL_MS = 30 * 60 * 1000;

console.log("\n📱 ProfitDesk WhatsApp Bot Started");
console.log(`   PHONE_NUMBER_ID:  ${PHONE_NUMBER_ID  ? "✅" : "❌ MISSING"}`);
console.log(`   ACCESS_TOKEN:     ${ACCESS_TOKEN     ? "✅" : "❌ MISSING"}`);
console.log(`   FLOW_ID:          ${FLOW_ID          || "❌ MISSING"}`);
console.log(`   FLOW_PRIVATE_KEY: ${FLOW_PRIVATE_KEY ? "✅" : "❌ MISSING"}\n`);

// ═══════════════════════════════════════════════════════════════════════════════
// 📝 CATEGORY MAP
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
  if (d.length === 10)                        return `+91${d}`;
  if (d.length === 12 && d.startsWith("91"))  return `+${d}`;
  if (d.length === 13 && d.startsWith("910")) return `+91${d.slice(3)}`;
  return `+${d}`;
}

function last10(phone) {
  return String(phone || "").replace(/\D/g, "").slice(-10);
}

function normalizeFrom(raw) {
  if (!raw) return raw;
  const s = String(raw).trim();
  if (s.startsWith("+")) return s;
  return toE164Indian(s);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 💾 IN-MEMORY SESSION STORE
// ═══════════════════════════════════════════════════════════════════════════════

const sessions = {};

function getSession(from) {
  const now = Date.now();
  if (sessions[from] && now - sessions[from].createdAt > SESSION_TTL_MS) {
    console.log(`🗑️  Session expired for ${from} — evicting`);
    delete sessions[from];
  }
  if (!sessions[from]) {
    sessions[from] = {
      createdAt: now,
      user:      null,
      projects:  [],
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
    console.log("🔐 Decryption started...");
    const encryptedAesKey = Buffer.from(body.encrypted_aes_key, "base64");

    let privateKeyObj;
    try {
      privateKeyObj = crypto.createPrivateKey(FLOW_PRIVATE_KEY);
    } catch {
      privateKeyObj = crypto.createPrivateKey(FLOW_PRIVATE_KEY.replace(/\\n/g, "\n"));
      console.log("✅ Private key parsed after newline fix");
    }

    const decryptedAesKey = crypto.privateDecrypt(
      { key: privateKeyObj, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      encryptedAesKey
    );

    const iv         = Buffer.from(body.initial_vector, "base64");
    const encrypted  = Buffer.from(body.encrypted_flow_data, "base64");
    const TAG_LENGTH = 16;
    const tag        = encrypted.slice(-TAG_LENGTH);
    const ciphertext = encrypted.slice(0, -TAG_LENGTH);
    const decipher   = crypto.createDecipheriv("aes-128-gcm", decryptedAesKey, iv);
    decipher.setAuthTag(tag);
    const decrypted  = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    console.log("✅ Decryption complete");
    return { parsed: JSON.parse(decrypted.toString("utf8")), aesKey: decryptedAesKey, iv };
  } catch (err) {
    console.error("❌ Decryption error:", err.message);
    return null;
  }
}

function encryptFlowResponse(responseObj, aesKey, iv) {
  const flippedIv = Buffer.from(iv).map((b) => ~b & 0xff);
  const cipher    = crypto.createCipheriv("aes-128-gcm", aesKey, flippedIv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(responseObj), "utf8"), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString("base64");
}

function sendEncrypted(res, responseObj, aesKey, iv) {
  try {
    const encrypted = encryptFlowResponse(responseObj, aesKey, iv);
    res.set("Content-Type", "text/plain");
    return res.status(200).send(encrypted);
  } catch (err) {
    console.error("❌ Encryption failed:", err.message);
    res.status(500).end();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔍 DB HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function findUserByPhone(whatsappNumber) {
  if (!whatsappNumber) return null;
  const tail10     = last10(whatsappNumber);
  console.log(`🔍 findUserByPhone | input="${whatsappNumber}" tail10="${tail10}"`);

  // Skip lookup for test/dummy tokens
  if (tail10.length < 10 || isNaN(Number(tail10))) {
    console.warn(`⚠️ Skipping DB lookup — looks like test token: "${whatsappNumber}"`);
    return null;
  }

  const candidates = [`+91${tail10}`, `91${tail10}`, tail10, `0${tail10}`];

  let user = await User.findOne(
    { mobile: { $in: candidates }, isActive: true },
    null,
    { lean: false }
  ).populate("companies");

  if (user) {
    console.log(`✅ User found (direct): "${user.name}" mobile="${user.mobile}"`);
    return user;
  }

  // Full scan fallback
  const all     = await User.find({ isActive: true }).populate("companies");
  const matched = all.find((u) => last10(u.mobile) === tail10);
  if (matched) {
    console.log(`✅ User found (scan): "${matched.name}" mobile="${matched.mobile}"`);
    User.updateOne({ _id: matched._id }, { $set: { mobile: toE164Indian(matched.mobile) } })
      .catch((e) => console.warn("⚠️ Auto-heal failed:", e.message));
    return matched;
  }

  console.warn(`❌ No user for "${whatsappNumber}" (tail="${tail10}") tried: ${JSON.stringify(candidates)}`);
  return null;
}

async function loadProjects(user) {
  if (!user || !user.companies || user.companies.length === 0) {
    console.warn("⚠️ loadProjects: no companies on user");
    return [];
  }
  const companyIds = user.companies.map((c) => c._id || c);
  const rows = await Project.find({ company: { $in: companyIds }, isActive: true }).lean();
  console.log(`📁 loadProjects: ${rows.length} projects for "${user.name}"`);
  return rows.map((p) => ({
    id:    String(p._id),
    title: p.name + (p.location ? ` — ${p.location}` : ""),
  }));
}

async function ensureSession(from, session) {
  if (!session.user) session.user = await findUserByPhone(from);
  if (session.user && (!session.projects || session.projects.length === 0)) {
    session.projects = await loadProjects(session.user);
  }
  return session.user;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📤 WHATSAPP SEND HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function sendText(to, text) {
  try {
    await axios.post(
      `${GRAPH_URL}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`📤 Text sent to ${to}`);
  } catch (err) {
    console.error("❌ sendText error:", err.response?.data || err.message);
  }
}

async function sendFlowMessage(to, user) {
  try {
    const normalizedTo   = normalizeFrom(to);
    const session        = getSession(normalizedTo);
    session.user         = user;
    session.projects     = await loadProjects(user);
    console.log(`📁 Pre-cached ${session.projects.length} projects | user: ${user.name} | key: ${normalizedTo}`);

    await axios.post(
      `${GRAPH_URL}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "flow",
          body: {
            text: `Hello *${user.name}* 👋\nWelcome to *ProfitDesk*!\nTap below to create a new bill.`,
          },
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "6",
              flow_id:              FLOW_ID,
              flow_cta:             "📋 Create Bill",
              flow_token:           to,
              mode:                 "published",
            },
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Flow sent to ${to} (${user.name}) | flow_token: ${normalizedTo} | projects: ${session.projects.length}`);
  } catch (err) {
    console.error("❌ sendFlowMessage error:", err.response?.data || err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🤖 INCOMING MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleIncomingMessage(from, message) {
  console.log(`\n📨 Incoming | From: ${from} | Type: ${message.type}`);
  if (message.type !== "text") return;

  const user = await findUserByPhone(from);
  if (!user) {
    await sendText(from,
      "❌ Your number is not registered in ProfitDesk.\n\nPlease contact your admin to get access."
    );
    return;
  }

  const normalizedFrom = normalizeFrom(from);
  const session        = getSession(normalizedFrom);
  session.user         = user;
  session.projects     = await loadProjects(user);
  console.log(`✅ Session ready | ${user.name} | key: ${normalizedFrom} | projects: ${session.projects.length}`);

  await sendFlowMessage(from, user);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔄 FLOW ACTION HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleFlowAction(from, action, screen, data, session) {
  console.log(`\n🔄 handleFlowAction | from="${from}" action="${action}" screen="${screen}"`);

  // ── INIT ─────────────────────────────────────────────────────────────────────
  if (action === "INIT") {
    console.log(`🔍 INIT | from="${from}" | session.projects=${session.projects?.length}`);

    const user = await findUserByPhone(from);
    let projects = [];

    if (user) {
      projects         = await loadProjects(user);
      session.user     = user;
      session.projects = projects;
    }

    console.log(`📤 INIT response | user="${user?.name || "NOT FOUND"}" | projects=${projects.length}`);

    // ✅ Empty projects fix — RadioButtonsGroup needs at least 1 item
    if (projects.length === 0) {
      projects = [{ id: "none", title: user ? "No projects assigned" : "Not registered — contact admin" }];
    }

    return {
      version: "3.0",
      screen:  "BILL_FORM",
      data: {
        projects,
        project_error:  user ? "" : "Your number is not registered. Contact admin.",
        category_error: "",
        amount_error:   "",
      },
    };
  }

  // ── DATA EXCHANGE ─────────────────────────────────────────────────────────────
  if (action === "data_exchange") {

    // ── BILL_FORM → ADD_PHOTOS ────────────────────────────────────────────────
    if (screen === "BILL_FORM") {
      const user = await ensureSession(from, session);

      if (!user) {
        return {
          version: "3.0",
          screen:  "BILL_FORM",
          data: {
            projects:       [{ id: "none", title: "Session expired — send any message to restart" }],
            project_error:  "Session expired. Send any message to restart.",
            category_error: "",
            amount_error:   "",
          },
        };
      }

      const projectId     = data?.selected_project;
      const billType      = data?.bill_type;
      const amount        = parseFloat(String(data?.bill_amount || "").replace(/,/g, ""));
      const freshProjects = session.projects;

      // Block dummy project selection
      const projectError  = (!projectId || projectId === "none")      ? "Please select a project."     : "";
      const categoryError = !billType || !CATEGORY_MAP[billType]      ? "Please select a category."    : "";
      const amountError   = isNaN(amount) || amount <= 0              ? "Please enter a valid amount." : "";

      if (projectError || categoryError || amountError) {
        const displayProjects = freshProjects.length > 0
          ? freshProjects
          : [{ id: "none", title: "No projects assigned" }];
        return {
          version: "3.0",
          screen:  "BILL_FORM",
          data: { projects: displayProjects, project_error: projectError, category_error: categoryError, amount_error: amountError },
        };
      }

      const project             = freshProjects.find((p) => p.id === projectId);
      session.bill.project_id   = projectId;
      session.bill.project_name = project?.title || projectId;
      session.bill.bill_type    = CATEGORY_MAP[billType];
      session.bill.bill_amount  = amount;
      session.bill.vendor_name  = data?.vendor_name?.trim() || "";
      session.bill.remarks      = data?.remarks?.trim()     || "";

      console.log(`📝 BILL_FORM → ADD_PHOTOS | ${session.bill.project_name} ₹${amount}`);
      return { version: "3.0", screen: "ADD_PHOTOS", data: { error_message: "" } };
    }

    // ── ADD_PHOTOS → ADD_DOCUMENTS ────────────────────────────────────────────
    if (screen === "ADD_PHOTOS") {
      const photos = data?.photo_attachments || [];
      session.bill.photo_attachments = Array.isArray(photos) ? photos : [];
      console.log(`📸 Photos: ${session.bill.photo_attachments.length}`);
      return { version: "3.0", screen: "ADD_DOCUMENTS", data: { error_message: "" } };
    }

    // ── ADD_DOCUMENTS → REVIEW ────────────────────────────────────────────────
    if (screen === "ADD_DOCUMENTS") {
      const docs = data?.document_attachments || [];
      session.bill.document_attachments = Array.isArray(docs) ? docs : [];

      const totalFiles = session.bill.photo_attachments.length + session.bill.document_attachments.length;
      const attachText = totalFiles === 0 ? "No files" : `${totalFiles} file${totalFiles > 1 ? "s" : ""}`;

      console.log(`📄 Docs: ${session.bill.document_attachments.length} | total: ${totalFiles}`);
      return {
        version: "3.0",
        screen:  "REVIEW",
        data: {
          user_name:         session.user?.name                        || "—",
          project_name:      session.bill.project_name                 || "—",
          bill_type:         session.bill.bill_type                    || "—",
          bill_amount:       session.bill.bill_amount.toLocaleString("en-IN"),
          vendor_name:       session.bill.vendor_name                  || "Not specified",
          attachments_count: attachText,
          remarks:           session.bill.remarks                      || "None",
          error_message:     "",
        },
      };
    }

    // ── REVIEW → SUCCESS ──────────────────────────────────────────────────────
    if (screen === "REVIEW") {
      const confirmation = data?.confirmation;
      const allFiles     = [...session.bill.photo_attachments, ...session.bill.document_attachments];
      const totalFiles   = allFiles.length;
      const attachText   = totalFiles === 0 ? "No files" : `${totalFiles} file${totalFiles > 1 ? "s" : ""}`;

      if (!confirmation) {
        return {
          version: "3.0",
          screen:  "REVIEW",
          data: {
            user_name:         session.user?.name                                || "—",
            project_name:      session.bill.project_name                         || "—",
            bill_type:         session.bill.bill_type                            || "—",
            bill_amount:       session.bill.bill_amount?.toLocaleString("en-IN") || "0",
            vendor_name:       session.bill.vendor_name                          || "Not specified",
            attachments_count: attachText,
            remarks:           session.bill.remarks                              || "None",
            error_message:     "Please confirm or cancel to proceed.",
          },
        };
      }

      // ── CANCEL ────────────────────────────────────────────────────────────────
      if (confirmation === "cancel") {
        clearSession(from);
        sendText(from,
          "🚫 Bill cancelled.\n\n_Send any message to create a new bill._"
        ).catch((e) => console.error("❌ sendText cancel:", e.message));
        return {
          version: "3.0",
          screen:  "SUCCESS",
          data: {
            bill_id:           "Cancelled",
            project_name:      "—",
            bill_type:         "—",
            bill_amount:       "0",
            vendor_name:       "—",
            attachments_count: "—",
          },
        };
      }

      // ── CONFIRM → Save to DB ──────────────────────────────────────────────────
      if (confirmation === "confirm") {
        try {
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
            vendor:      session.bill.vendor_name,
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

          console.log(`✅ Bill saved: ${billId} | ${billType} | ₹${fmt} | files: ${fileCount}`);
          clearSession(from);

          sendText(from,
            `✅ *Bill Created Successfully!*\n\n` +
            `📝 Bill ID:   *${billId}*\n` +
            `🏗️ Project:  ${projectName}\n` +
            `📋 Category: ${billType}\n` +
            `💰 Amount:   ₹${fmt}\n` +
            `🏪 Vendor:   ${vendor}\n` +
            `📎 Files:    ${fileCount > 0 ? `${fileCount} attached` : "None"}\n` +
            `📌 Status:   In Progress\n\n` +
            `_Send any message to create another bill._`
          ).catch((e) => console.error("❌ sendText confirm:", e.message));

          return {
            version: "3.0",
            screen:  "SUCCESS",
            data: {
              bill_id:           billId,
              project_name:      projectName,
              bill_type:         billType,
              bill_amount:       fmt,
              vendor_name:       vendor,
              attachments_count: fileCount > 0 ? `${fileCount} file${fileCount > 1 ? "s" : ""}` : "No files",
            },
          };
        } catch (err) {
          console.error("❌ Bill save error:", err.message);
          return {
            version: "3.0",
            screen:  "REVIEW",
            data: {
              user_name:         session.user?.name                                || "—",
              project_name:      session.bill.project_name                         || "—",
              bill_type:         session.bill.bill_type                            || "—",
              bill_amount:       session.bill.bill_amount?.toLocaleString("en-IN") || "0",
              vendor_name:       session.bill.vendor_name                          || "Not specified",
              attachments_count: attachText,
              remarks:           session.bill.remarks                              || "None",
              error_message:     `❌ Save failed: ${err.message}`,
            },
          };
        }
      }
    }
  }

  // ── FALLBACK ──────────────────────────────────────────────────────────────────
  console.warn(`⚠️  Unhandled | screen="${screen}" action="${action}"`);
  await ensureSession(from, session);
  const fallbackProjects = session.projects?.length > 0
    ? session.projects
    : [{ id: "none", title: "No projects assigned" }];
  return {
    version: "3.0",
    screen:  "BILL_FORM",
    data: { projects: fallbackProjects, project_error: "", category_error: "", amount_error: "" },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📨 WEBHOOK ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

router.get("/debug-users", async (req, res) => {
  try {
    const users = await User.find({}).select("name mobile isActive").lean();
    res.json({ count: users.length, users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/debug-projects", async (req, res) => {
  try {
    const allProjects = await Project.find({}).lean();
    const users       = await User.find({ isActive: true }).populate("companies").lean();
    const mapped      = [];
    for (const u of users) {
      const companyIds = u.companies.map((c) => c._id);
      const projects   = await Project.find({ company: { $in: companyIds }, isActive: true }).lean();
      mapped.push({
        user:      u.name,
        mobile:    u.mobile,
        companies: u.companies.map((c) => ({ id: c._id, name: c.name })),
        projects:  projects.map((p) => ({ id: p._id, name: p.name, isActive: p.isActive })),
      });
    }
    res.json({
      allProjectsInDB:    allProjects.map((p) => ({ id: p._id, name: p.name, company: p.company, isActive: p.isActive })),
      userProjectMapping: mapped,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

router.post("/", (req, res) => {
  res.sendStatus(200);
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

// ── /flow — ALL responses must be encrypted, never raw JSON ──────────────────
router.post("/flow", async (req, res) => {
  console.log(`\n📨 Flow Request received`);

  if (!FLOW_PRIVATE_KEY) {
    console.error("❌ FLOW_PRIVATE_KEY missing");
    return res.status(500).end();
  }

  const decrypted = decryptFlowRequest(req.body);
  if (!decrypted) {
    console.error("❌ Decryption failed — sending 200 end to avoid WhatsApp retry loop");
    return res.status(200).end();
  }

  const { aesKey, iv, parsed } = decrypted;
  console.log(`📦 Parsed: ${JSON.stringify(parsed)}`);

  const { action, screen, flow_token, data } = parsed;
  console.log(`   action="${action}" screen="${screen}" flow_token="${flow_token}"`);

  try {
    if (action === "ping") {
      return sendEncrypted(res, { version: "3.0", data: { status: "active" } }, aesKey, iv);
    }

    // Normalize flow_token to E.164 so session key always matches
    const rawToken = flow_token || "";
    const from     = rawToken ? normalizeFrom(rawToken) : "";
    console.log(`   normalized from: "${from}"`);

    if (!from) {
      console.error("❌ flow_token is empty or undefined");
      return sendEncrypted(res, {
        version: "3.0",
        screen:  "BILL_FORM",
        data: {
          projects:       [{ id: "none", title: "Session error — please restart" }],
          project_error:  "Session error. Please restart.",
          category_error: "",
          amount_error:   "",
        },
      }, aesKey, iv);
    }

    const session     = getSession(from);
    const responseObj = await handleFlowAction(from, action, screen, data, session);

    console.log(`📤 Responding with screen: "${responseObj.screen}"`);
    return sendEncrypted(res, responseObj, aesKey, iv);

  } catch (err) {
    console.error("❌ Flow handler error:", err.message);
    console.error(err.stack);
    return sendEncrypted(res, {
      version: "3.0",
      screen:  "BILL_FORM",
      data: {
        projects:       [{ id: "none", title: "Server error — please try again" }],
        project_error:  "Server error. Please try again.",
        category_error: "",
        amount_error:   "",
      },
    }, aesKey, iv);
  }
});

module.exports = router;
