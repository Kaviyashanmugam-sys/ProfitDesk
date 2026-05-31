const express = require("express");
const router  = express.Router();
const axios   = require("axios");
const crypto  = require("crypto");

const Project = require("../models/Project");
const Bill    = require("../models/Bill");
const User    = require("../models/User");

const VERIFY_TOKEN     = process.env.WHATSAPP_VERIFY_TOKEN    || "profitdesk_verify_token";
const PHONE_NUMBER_ID  = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN     = process.env.WHATSAPP_ACCESS_TOKEN;
const FLOW_ID          = process.env.FLOW_ID;
const FLOW_PRIVATE_KEY = process.env.FLOW_PRIVATE_KEY;
const GRAPH_URL        = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}`;
const SESSION_TTL_MS   = 30 * 60 * 1000;

console.log("\n📱 ProfitDesk WhatsApp Bot Started");
console.log(`   PHONE_NUMBER_ID:  ${PHONE_NUMBER_ID  ? "✅" : "❌ MISSING"}`);
console.log(`   ACCESS_TOKEN:     ${ACCESS_TOKEN     ? "✅" : "❌ MISSING"}`);
console.log(`   FLOW_ID:          ${FLOW_ID          || "❌ MISSING"}`);
console.log(`   FLOW_PRIVATE_KEY: ${FLOW_PRIVATE_KEY ? "✅" : "❌ MISSING"}\n`);

const CATEGORY_MAP = {
  Material:  "Material",
  Manpower:  "Labour",
  Equipment: "Machineries",
  Others:    "Others",
};

function toE164Indian(phone) {
  if (!phone) return null;
  const d = String(phone).replace(/\D/g, "");
  if (d.length === 10)                        return "+91" + d;
  if (d.length === 12 && d.startsWith("91"))  return "+" + d;
  if (d.length === 13 && d.startsWith("910")) return "+91" + d.slice(3);
  return "+" + d;
}
function last10(phone) { return String(phone || "").replace(/\D/g, "").slice(-10); }
function normalizeFrom(raw) {
  if (!raw) return raw;
  const s = String(raw).trim();
  if (s.startsWith("+")) return s;
  return toE164Indian(s);
}

const sessions = {};
function getSession(from) {
  const now = Date.now();
  if (sessions[from] && now - sessions[from].createdAt > SESSION_TTL_MS) {
    delete sessions[from];
  }
  if (!sessions[from]) {
    sessions[from] = {
      createdAt: now,
      user: null,
      bill: {
        project_name: "", bill_type: null, bill_amount: null,
        vendor_name: "", remarks: "", photo_attachments: [], document_attachments: [],
      },
    };
  }
  return sessions[from];
}
function clearSession(from) { delete sessions[from]; }

function decryptFlowRequest(body) {
  try {
    console.log("🔐 Decryption started...");
    const encryptedAesKey = Buffer.from(body.encrypted_aes_key, "base64");
    let privateKeyObj;
    try { privateKeyObj = crypto.createPrivateKey(FLOW_PRIVATE_KEY); }
    catch { privateKeyObj = crypto.createPrivateKey(FLOW_PRIVATE_KEY.replace(/\\n/g, "\n")); }
    const decryptedAesKey = crypto.privateDecrypt(
      { key: privateKeyObj, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      encryptedAesKey
    );
    const iv        = Buffer.from(body.initial_vector, "base64");
    const encrypted = Buffer.from(body.encrypted_flow_data, "base64");
    const TAG_LENGTH = 16;
    const tag        = encrypted.slice(-TAG_LENGTH);
    const ciphertext = encrypted.slice(0, -TAG_LENGTH);
    const decipher   = crypto.createDecipheriv("aes-128-gcm", decryptedAesKey, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    console.log("✅ Decryption complete");
    return { parsed: JSON.parse(decrypted.toString("utf8")), aesKey: decryptedAesKey, iv };
  } catch (err) { console.error("❌ Decryption error:", err.message); return null; }
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
  } catch (err) { console.error("❌ Encryption failed:", err.message); res.status(500).end(); }
}

async function findUserByPhone(whatsappNumber) {
  if (!whatsappNumber) return null;
  const tail10 = last10(whatsappNumber);
  console.log(`🔍 findUserByPhone | input="${whatsappNumber}" tail10="${tail10}"`);
  if (tail10.length < 10 || isNaN(Number(tail10))) {
    console.warn(`⚠️ Skipping — test token: "${whatsappNumber}"`); return null;
  }
  const candidates = ["+91" + tail10, "91" + tail10, tail10, "0" + tail10];
  let user = await User.findOne({ mobile: { $in: candidates }, isActive: true }, null, { lean: false }).populate("companies");
  if (user) {
    console.log(`✅ User found (direct): "${user.name}" mobile="${user.mobile}"`);
    return user;
  }
  const all     = await User.find({ isActive: true }).populate("companies");
  const matched = all.find((u) => last10(u.mobile) === tail10);
  if (matched) {
    console.log(`✅ User found (scan): "${matched.name}"`);
    User.updateOne({ _id: matched._id }, { $set: { mobile: toE164Indian(matched.mobile) } }).catch(() => {});
    return matched;
  }
  console.warn(`❌ No user for "${whatsappNumber}"`);
  return null;
}

async function sendText(to, text) {
  try {
    await axios.post(`${GRAPH_URL}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`📤 Text sent to ${to}`);
  } catch (err) { console.error("❌ sendText error:", err.response?.data || err.message); }
}

async function sendFlowMessage(to, user) {
  try {
    const normalizedTo = normalizeFrom(to);
    await axios.post(`${GRAPH_URL}/messages`,
      {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
          type: "flow",
          body: { text: `Hello *${user.name}* 👋\nWelcome to *ProfitDesk*!\nTap below to create a new bill.` },
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3", flow_id: FLOW_ID,
              flow_cta: "📋 Create Bill", flow_token: normalizedTo, mode: "published",
            },
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`✅ Flow sent to ${to} (${user.name})`);
  } catch (err) { console.error("❌ sendFlowMessage error:", err.response?.data || err.message); }
}

async function handleIncomingMessage(from, message) {
  console.log(`\n📨 Incoming | From: ${from} | Type: ${message.type}`);
  if (message.type !== "text") return;
  const user = await findUserByPhone(from);
  if (!user) {
    await sendText(from, "❌ Your number is not registered in ProfitDesk.\n\nPlease contact your admin.");
    return;
  }
  await sendFlowMessage(from, user);
}

async function handleFlowAction(from, action, screen, data, session) {
  console.log(`\n🔄 handleFlowAction | from="${from}" action="${action}" screen="${screen}"`);

  // ─── INIT ───────────────────────────────────────────────────────────────────
  if (action === "INIT") {
    session.user = await findUserByPhone(from);

    if (session.user && (!session.user.companies || session.user.companies.length === 0)) {
      await session.user.populate("companies");
    }

    console.log(`📤 INIT | user="${session.user?.name || "NOT FOUND"}" | companies=${session.user?.companies?.length || 0}`);

    return {
      version: "3.0",
      screen:  "BILL_FORM",
      data: {
        project_error:  "",
        category_error: "",
        amount_error:   "",
      },
    };
  }

  // ─── DATA EXCHANGE ──────────────────────────────────────────────────────────
  if (action === "data_exchange") {

    // ── BILL_FORM ──
    if (screen === "BILL_FORM") {
      const projectName   = (data?.selected_project || "").trim();
      const billType      = data?.bill_type;
      const amount        = parseFloat(String(data?.bill_amount || "").replace(/,/g, ""));
      const projectError  = !projectName                          ? "Please enter project name."   : "";
      const categoryError = !billType || !CATEGORY_MAP[billType] ? "Please select a category."   : "";
      const amountError   = isNaN(amount) || amount <= 0         ? "Please enter a valid amount." : "";

      if (projectError || categoryError || amountError) {
        return {
          version: "3.0", screen: "BILL_FORM",
          data: { project_error: projectError, category_error: categoryError, amount_error: amountError },
        };
      }

      session.bill.project_name = projectName;
      session.bill.bill_type    = CATEGORY_MAP[billType];
      session.bill.bill_amount  = amount;
      session.bill.vendor_name  = (data?.vendor_name || "").trim();
      session.bill.remarks      = (data?.remarks     || "").trim();
      console.log(`📝 BILL_FORM → ADD_PHOTOS | project="${projectName}" amount=₹${amount}`);
      return { version: "3.0", screen: "ADD_PHOTOS", data: { error_message: "" } };
    }

    // ── ADD_PHOTOS ──
    if (screen === "ADD_PHOTOS") {
      const photos = data?.photo_attachments || [];
      session.bill.photo_attachments = Array.isArray(photos) ? photos : [];
      console.log(`📸 Photos: ${session.bill.photo_attachments.length}`);
      return { version: "3.0", screen: "ADD_DOCUMENTS", data: { error_message: "" } };
    }

    // ── ADD_DOCUMENTS ──
    if (screen === "ADD_DOCUMENTS") {
      const docs = data?.document_attachments || [];
      session.bill.document_attachments = Array.isArray(docs) ? docs : [];
      const totalFiles = session.bill.photo_attachments.length + session.bill.document_attachments.length;
      const attachText = totalFiles === 0 ? "No files" : `${totalFiles} file${totalFiles > 1 ? "s" : ""}`;
      return {
        version: "3.0", screen: "REVIEW",
        data: {
          user_name:         session.user?.name                                || "—",
          project_name:      session.bill.project_name                         || "—",
          bill_type:         session.bill.bill_type                            || "—",
          bill_amount:       session.bill.bill_amount?.toLocaleString("en-IN") || "0",
          vendor_name:       session.bill.vendor_name                          || "Not specified",
          attachments_count: attachText,
          remarks:           session.bill.remarks                              || "None",
          error_message:     "",
        },
      };
    }

    // ── REVIEW ──
    if (screen === "REVIEW") {
      const confirmation = data?.confirmation;
      const allFiles     = [...(session.bill.photo_attachments || []), ...(session.bill.document_attachments || [])];
      const totalFiles   = allFiles.length;
      const attachText   = totalFiles === 0 ? "No files" : `${totalFiles} file${totalFiles > 1 ? "s" : ""}`;

      if (!confirmation) {
        return {
          version: "3.0", screen: "REVIEW",
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

      // ── CANCEL ──
      if (confirmation === "cancel") {
        clearSession(from);
        sendText(from, "🚫 Bill cancelled.\n\n_Send any message to create a new bill._").catch(() => {});
        return {
          version: "3.0", screen: "SUCCESS",
          data: { bill_id: "Cancelled", project_name: "—", bill_type: "—", bill_amount: "0", vendor_name: "—", attachments_count: "—" },
        };
      }

      // ── CONFIRM ──
      if (confirmation === "confirm") {
        try {
          // 🔧 Re-fetch user if null
          let user = session.user;
          if (!user) user = await findUserByPhone(from);
          if (!user) throw new Error("User not found. Please contact admin.");

          // 🔧 Re-populate companies if missing
          if (!user.companies || user.companies.length === 0) {
            await user.populate("companies");
          }
          if (!user.companies || user.companies.length === 0) {
            throw new Error("No company linked to this user. Please contact admin.");
          }

          console.log(`👤 User: ${user.name} | Companies: ${user.companies.length}`);

          const billCount = await Bill.countDocuments({});
          const now       = new Date();
          const mm        = String(now.getMonth() + 1).padStart(2, "0");
          const yyyy      = now.getFullYear();
          const billId    = `B/${mm}/${yyyy}-${String(billCount + 1).padStart(5, "0")}`;

          // Find matching project in DB
          const companyIds  = user.companies.map((c) => c._id || c);
          const allProjects = await Project.find({ isActive: true }).lean();
          const matched     = allProjects.find(
            (p) => p.name.toLowerCase() === session.bill.project_name.toLowerCase()
          );
          const companyId = user.companies[0]?._id || user.companies[0];

          const newBill = new Bill({
            billId,
            date:        now,
            project:     matched?._id || null,
            company:     companyId,
            engineer:    user._id,
            category:    session.bill.bill_type,
            amount:      session.bill.bill_amount,
            vendor:      session.bill.vendor_name,
            remarks:     session.bill.remarks,
            status:      "In Progress",
            attachments: allFiles,
          });

          await newBill.save();

          const fmt = session.bill.bill_amount.toLocaleString("en-IN");
          console.log(`✅ Bill saved: ${billId}`);

          // Save data before clearing session
          const savedBill = {
            billId,
            project_name: session.bill.project_name,
            bill_type:    session.bill.bill_type,
            bill_amount:  fmt,
            vendor_name:  session.bill.vendor_name || "—",
            totalFiles,
            attachText,
          };

          clearSession(from);

          sendText(from,
            `✅ *Bill Created Successfully!*\n\n` +
            `📝 Bill ID:   *${savedBill.billId}*\n` +
            `🏗️ Project:  ${savedBill.project_name}\n` +
            `📋 Category: ${savedBill.bill_type}\n` +
            `💰 Amount:   ₹${savedBill.bill_amount}\n` +
            `🏪 Vendor:   ${savedBill.vendor_name}\n` +
            `📎 Files:    ${savedBill.totalFiles > 0 ? savedBill.totalFiles + " attached" : "None"}\n` +
            `📌 Status:   In Progress\n\n` +
            `_Send any message to create another bill._`
          ).catch(() => {});

          return {
            version: "3.0", screen: "SUCCESS",
            data: {
              bill_id:           savedBill.billId,
              project_name:      savedBill.project_name,
              bill_type:         savedBill.bill_type,
              bill_amount:       savedBill.bill_amount,
              vendor_name:       savedBill.vendor_name,
              attachments_count: savedBill.attachText,
            },
          };

        } catch (err) {
          console.error("❌ Bill save error:", err.message);
          const af     = [...(session.bill.photo_attachments || []), ...(session.bill.document_attachments || [])];
          const afText = af.length === 0 ? "No files" : `${af.length} file${af.length > 1 ? "s" : ""}`;
          return {
            version: "3.0", screen: "REVIEW",
            data: {
              user_name:         session.user?.name                                || "—",
              project_name:      session.bill.project_name                         || "—",
              bill_type:         session.bill.bill_type                            || "—",
              bill_amount:       session.bill.bill_amount?.toLocaleString("en-IN") || "0",
              vendor_name:       session.bill.vendor_name                          || "Not specified",
              attachments_count: afText,
              remarks:           session.bill.remarks                              || "None",
              error_message:     "❌ Save failed: " + err.message,
            },
          };
        }
      }
    }
  }

  console.warn(`⚠️ Unhandled | screen="${screen}" action="${action}"`);
  return { version: "3.0", screen: "BILL_FORM", data: { project_error: "", category_error: "", amount_error: "" } };
}

// ─── ROUTES ─────────────────────────────────────────────────────────────────

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get("/debug-projects", async (req, res) => {
  try {
    const allProjects = await Project.find({}).lean();
    const users       = await User.find({ isActive: true }).populate("companies").lean();
    const mapped      = [];
    for (const u of users) {
      const companyIds = u.companies.map((c) => c._id);
      const projects   = await Project.find({ company: { $in: companyIds }, isActive: true }).lean();
      mapped.push({ user: u.name, mobile: u.mobile, projects: projects.map((p) => ({ id: p._id, name: p.name })) });
    }
    res.json({ allProjectsInDB: allProjects.map((p) => ({ id: p._id, name: p.name })), userProjectMapping: mapped });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/", (req, res) => {
  res.sendStatus(200);
  try {
    const value   = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (!value?.messages) return;
    const message = value.messages[0];
    const from    = message?.from;
    if (!from || !message) return;
    handleIncomingMessage(from, message).catch((e) => console.error("❌ handleIncomingMessage:", e.message));
  } catch (err) { console.error("❌ Webhook POST:", err.message); }
});

router.post("/flow", async (req, res) => {
  console.log(`\n📨 Flow Request received`);
  if (!FLOW_PRIVATE_KEY) { console.error("❌ FLOW_PRIVATE_KEY missing"); return res.status(500).end(); }
  const decrypted = decryptFlowRequest(req.body);
  if (!decrypted) { console.error("❌ Decryption failed"); return res.status(200).end(); }
  const { aesKey, iv, parsed } = decrypted;
  console.log(`📦 Parsed: ${JSON.stringify(parsed)}`);
  const { action, screen, flow_token, data } = parsed;
  console.log(`   action="${action}" screen="${screen}" flow_token="${flow_token}"`);
  try {
    if (action === "ping") return sendEncrypted(res, { version: "3.0", data: { status: "active" } }, aesKey, iv);
    const rawToken = flow_token || "";
    const from     = rawToken ? normalizeFrom(rawToken) : "";
    console.log(`   normalized from: "${from}"`);
    if (!from) {
      return sendEncrypted(res, {
        version: "3.0", screen: "BILL_FORM",
        data: { project_error: "Session error. Please restart.", category_error: "", amount_error: "" },
      }, aesKey, iv);
    }
    const session     = getSession(from);
    const responseObj = await handleFlowAction(from, action, screen, data, session);
    console.log(`📤 Responding with screen: "${responseObj.screen}"`);
    return sendEncrypted(res, responseObj, aesKey, iv);
  } catch (err) {
    console.error("❌ Flow handler error:", err.message);
    return sendEncrypted(res, {
      version: "3.0", screen: "BILL_FORM",
      data: { project_error: "Server error. Please try again.", category_error: "", amount_error: "" },
    }, aesKey, iv);
  }
});

module.exports = router;