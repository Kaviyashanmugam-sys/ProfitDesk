const { Router } = require("express");
const axios = require("axios");
const crypto = require("crypto");

const router = Router();

const VERIFY_TOKEN     = process.env.WHATSAPP_VERIFY_TOKEN    || "profitdesk_verify_token";
const PHONE_NUMBER_ID  = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN     = process.env.WHATSAPP_ACCESS_TOKEN;
const CUSTOMER_API     = process.env.CUSTOMER_API_BASE_URL    || "https://prod.thinksoft.in/profitdesk/api/site-engineer";
const FLOW_ID          = process.env.FLOW_ID;
const FLOW_PRIVATE_KEY = process.env.FLOW_PRIVATE_KEY;
const GRAPH_URL        = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}`;
const SESSION_TTL_MS   = 30 * 60 * 1000;

// ═════════════════════════════════════════════════════════════════════════════
// PHONE FORMAT HELPERS
// ═════════════════════════════════════════════════════════════════════════════

function phone10(raw) {
  if (!raw) return "";
  return String(raw).replace(/\D/g, "").slice(-10);
}

function phone91(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 10) return "91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return digits;
}

async function apiPostWithPhoneFallback(endpoint, baseBody, rawPhone) {
  const p10 = phone10(rawPhone);
  const p91 = phone91(rawPhone);
  let result = await apiPost(endpoint, { ...baseBody, phone: p10 });
  if (result) { console.log(`[apiPost] ${endpoint} matched with phone10: ${p10}`); return result; }
  result = await apiPost(endpoint, { ...baseBody, phone: p91 });
  if (result) { console.log(`[apiPost] ${endpoint} matched with phone91: ${p91}`); return result; }
  console.warn(`[apiPost] ${endpoint} failed for both ${p10} and ${p91}`);
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// FLOW ENCRYPTION / DECRYPTION
// ═════════════════════════════════════════════════════════════════════════════

function decryptFlowRequest(body) {
  const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;
  // Handle escaped newlines from env vars
  const rawKey = (FLOW_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const privateKey = crypto.createPrivateKey(rawKey);
  const decryptedAesKey = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(encrypted_aes_key, "base64")
  );
  const iv         = Buffer.from(initial_vector, "base64");
  const encBuf     = Buffer.from(encrypted_flow_data, "base64");
  const tag        = encBuf.slice(-16);
  const ciphertext = encBuf.slice(0, -16);
  const decipher   = crypto.createDecipheriv("aes-128-gcm", decryptedAesKey, iv);
  decipher.setAuthTag(tag);
  const decrypted  = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { decryptedBody: JSON.parse(decrypted.toString("utf8")), aesKey: decryptedAesKey, iv };
}

function encryptFlowResponse(responseObj, aesKey, iv) {
  const flippedIv = Buffer.from(iv.map((b) => ~b & 0xff));
  const cipher    = crypto.createCipheriv("aes-128-gcm", aesKey, flippedIv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(responseObj), "utf8"), cipher.final()]);
  const tag       = cipher.getAuthTag();
  return Buffer.concat([encrypted, tag]).toString("base64");
}

// ═════════════════════════════════════════════════════════════════════════════
// API RESPONSE → DROPDOWN MAPPER
// ═════════════════════════════════════════════════════════════════════════════

function toDropdownItem(item) {
  const id = String(
    item.id          != null ? item.id          :
    item.value       != null ? item.value       :
    item.category_id != null ? item.category_id :
    item.project_id  != null ? item.project_id  :
    item.vendor_id   != null ? item.vendor_id   :
    item.supplier_id != null ? item.supplier_id :
    item.company_id  != null ? item.company_id  : ""
  );
  const title = String(
    item.name          || item.label         || item.title         ||
    item.category_name || item.project_name  || item.vendor_name   ||
    item.supplier_name || item.company_name  || "Unknown"
  );
  return { id, title };
}

// ═════════════════════════════════════════════════════════════════════════════
// SESSION + CACHE
// ═════════════════════════════════════════════════════════════════════════════

const sessions      = new Map();
const flowDataCache = new Map();

function getSession(from, name) {
  const now = Date.now();
  if (sessions.has(from) && now - sessions.get(from).createdAt > SESSION_TTL_MS) sessions.delete(from);
  if (!sessions.has(from)) {
    sessions.set(from, {
      createdAt: now, step: "START",
      phone: phone10(from), rawPhone: from, name: name || "",
      company_id: null, company_label: "",
      amount: null, remarks: "", files: [],
    });
  }
  const session = sessions.get(from);
  if (name && !session.name) session.name = name;
  return session;
}

function clearSession(from) { sessions.delete(from); }

// ═════════════════════════════════════════════════════════════════════════════
// EXTERNAL API
// ═════════════════════════════════════════════════════════════════════════════

async function apiPost(endpoint, body) {
  try {
    const res = await axios.post(`${CUSTOMER_API}/${endpoint}`, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });
    if (res.data && String(res.data.status).toLowerCase() === "success") return res.data.data;
    console.warn(`[apiPost] ${endpoint} → status: ${res.data?.status} | msg: ${res.data?.message || "-"}`);
    return null;
  } catch (err) {
    console.error(`[apiPost] ${endpoint} error:`, err.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// FETCH DROPDOWNS — called when "hi" received, data embedded in flow payload
// ═════════════════════════════════════════════════════════════════════════════

async function fetchDropdowns(rawPhone) {
  // Return cached if available (valid for 10 min)
  const cached = flowDataCache.get(rawPhone);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) {
    console.log(`[fetchDropdowns] cache hit for ${phone10(rawPhone)}`);
    return cached;
  }

  console.log(`[fetchDropdowns] fetching for ${phone10(rawPhone)}`);
  const [categoryRes, projectRes, vendorRes] = await Promise.all([
    apiPostWithPhoneFallback("category-list",     {}, rawPhone),
    apiPostWithPhoneFallback("user-project-list", {}, rawPhone),
    apiPostWithPhoneFallback("vendor-list",       {}, rawPhone),
  ]);

  console.log(`[fetchDropdowns] cats=${JSON.stringify(categoryRes)}`);
  console.log(`[fetchDropdowns] projs=${JSON.stringify(projectRes)}`);
  console.log(`[fetchDropdowns] vendors=${JSON.stringify(vendorRes)}`);

  const categories = Array.isArray(categoryRes) && categoryRes.length > 0
    ? categoryRes.map(toDropdownItem)
    : [{ id: "err", title: "No categories found" }];

  const projects = Array.isArray(projectRes) && projectRes.length > 0
    ? projectRes.map(toDropdownItem)
    : [{ id: "err", title: "No projects found" }];

  const vendorItems = Array.isArray(vendorRes)
    ? vendorRes.filter(v => String(v.value ?? v.id) !== "0").map(toDropdownItem)
    : [];
  const vendors = [{ id: "0", title: "None" }, ...vendorItems];

  console.log(`[fetchDropdowns] → ${categories.length} cats | ${projects.length} projs | ${vendors.length} vendors`);

  const result = { categories, projects, vendors, ts: Date.now() };
  flowDataCache.set(rawPhone, result);
  return result;
}

// ═════════════════════════════════════════════════════════════════════════════
// WHATSAPP SENDERS
// ═════════════════════════════════════════════════════════════════════════════

async function sendText(to, text) {
  try {
    await axios.post(
      `${GRAPH_URL}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
  } catch (err) { console.error(`[sendText] error:`, err.response?.data || err.message); }
}

// Send Flow message with real dropdown data already embedded in payload
// User taps "Create Bill" → Flow opens directly on BILL_FORM with live data
async function sendFlowMessage(to, flowToken, rawPhone) {
  console.log(`[sendFlowMessage] to=${to} | FLOW_ID=${FLOW_ID}`);
  try {
    const { categories, projects, vendors } = await fetchDropdowns(rawPhone);

    await axios.post(
      `${GRAPH_URL}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "flow",
          body: { text: "Tap *Create Bill* to submit a new bill." },
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              flow_token:           flowToken,
              flow_id:              FLOW_ID,
              flow_cta:             "Create Bill",
              flow_action:          "navigate",
              flow_action_payload:  {
                screen: "BILL_FORM",
                data:   { categories, projects, vendors, error_message: "" },
              },
            },
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`[sendFlowMessage] ✅ sent | cats=${categories.length} projs=${projects.length} vendors=${vendors.length}`);
  } catch (err) {
    console.error(`[sendFlowMessage] ❌`, JSON.stringify(err.response?.data, null, 2) || err.message);
  }
}

async function downloadMedia(mediaId) {
  try {
    const urlRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const mediaUrl = urlRes.data?.url;
    if (!mediaUrl) return null;
    const fileRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      responseType: "arraybuffer",
    });
    const mimeType = fileRes.headers["content-type"] || "image/jpeg";
    return `data:${mimeType};base64,${Buffer.from(fileRes.data).toString("base64")}`;
  } catch (err) { return null; }
}

// ═════════════════════════════════════════════════════════════════════════════
// GREET + SEND FLOW
// ═════════════════════════════════════════════════════════════════════════════

async function stepWelcome(from, session) {
  // Verify phone is registered
  const companies = await apiPostWithPhoneFallback("user-company-list", {}, session.rawPhone);
  if (!companies || companies.length === 0) {
    await sendText(from, "❌ Your number is not registered in ProfitDesk.\nPlease contact your admin.");
    clearSession(from);
    return;
  }

  session.company_id    = String(companies[0].id != null ? companies[0].id : companies[0].value || "");
  session.company_label = String(companies[0].title || companies[0].label || companies[0].name || "");
  session.step          = "FLOW_SENT";

  const name = session.name || "there";
  await sendText(from, `Hi ${name}! 👋 Welcome to *ProfitDesk*.\n\nTap the button below to create a new bill.`);
  await sendFlowMessage(from, phone91(from), session.rawPhone);
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN MESSAGE HANDLER
// ═════════════════════════════════════════════════════════════════════════════

async function handleMessage(from, message, contactName) {
  const session = getSession(from, contactName);

  const text  = String(message.text?.body || "").trim();
  const lower = text.toLowerCase();

  if (lower === "cancel") {
    clearSession(from);
    await sendText(from, "Session cancelled. Send *hi* to start again.");
    return;
  }

  const greetings = ["hi", "hello", "hey", "hii", "hai", "helo", "hy"];

  switch (session.step) {
    case "START":
      if (greetings.includes(lower)) {
        await stepWelcome(from, session);
      } else {
        await sendText(from, "Send *hi* to get started with ProfitDesk. 👋");
      }
      break;

    case "FLOW_SENT":
      if (greetings.includes(lower)) {
        // Re-send flow message
        await sendText(from, `Hi ${session.name || "there"}! 👋 Here's your bill form again.`);
        await sendFlowMessage(from, phone91(from), session.rawPhone);
      } else {
        await sendText(from, "Please fill the bill form above. 📋\nType *cancel* to restart.");
      }
      break;

    default:
      if (greetings.includes(lower)) {
        clearSession(from);
        await stepWelcome(from, getSession(from, contactName));
      } else {
        await sendText(from, "Send *hi* to get started. 👋");
      }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WHATSAPP FLOW WEBHOOK — POST /webhook/flow
// ═════════════════════════════════════════════════════════════════════════════

router.post("/flow", async (req, res) => {
  console.log(`\n📋 Flow webhook hit | keys=${Object.keys(req.body).join(",")}`);

  try {
    let decryptedBody, aesKey, iv;
    try {
      const r  = decryptFlowRequest(req.body);
      decryptedBody = r.decryptedBody;
      aesKey        = r.aesKey;
      iv            = r.iv;
    } catch (decErr) {
      console.error("[Flow] Decrypt error:", decErr.message);
      return res.status(421).send("Decryption failed");
    }

    const { screen, data = {}, flow_token, action } = decryptedBody;
    const rawPhone = flow_token || "";
    console.log(`📋 screen=${screen || "-"} | action=${action} | flow_token=${rawPhone}`);

    const reply = (obj) => res.send(encryptFlowResponse(obj, aesKey, iv));

    // ── PING ──────────────────────────────────────────────────────────────────
    if (action === "ping") {
      return reply({ data: { status: "active" } });
    }

    // ── INIT — fallback fetch if somehow called ────────────────────────────────
    if (action === "INIT") {
      const { categories, projects, vendors } = await fetchDropdowns(rawPhone);
      return reply({ screen: "BILL_FORM", data: { categories, projects, vendors, error_message: "" } });
    }

    // ── BILL_FORM → validate → ADD_PHOTOS ─────────────────────────────────────
    if (screen === "BILL_FORM") {
      const { category, project, amount, vendor, remarks } = data;

      if (!category || !project || !amount) {
        const { categories, projects, vendors } = await fetchDropdowns(rawPhone);
        return reply({
          screen: "BILL_FORM",
          data:   { categories, projects, vendors, error_message: "Category, Project and Amount are required." },
        });
      }
      if (isNaN(Number(amount)) || Number(amount) <= 0) {
        const { categories, projects, vendors } = await fetchDropdowns(rawPhone);
        return reply({
          screen: "BILL_FORM",
          data:   { categories, projects, vendors, error_message: "Please enter a valid amount." },
        });
      }

      return reply({
        screen: "ADD_PHOTOS",
        data:   { error_message: "", category, project, vendor: vendor || "0", amount: String(amount), remarks: remarks || "" },
      });
    }

    // ── ADD_PHOTOS → ADD_DOCUMENTS ────────────────────────────────────────────
    if (screen === "ADD_PHOTOS") {
      const { category, project, vendor, amount, remarks, photos } = data;
      return reply({
        screen: "ADD_DOCUMENTS",
        data: {
          error_message: "",
          category:  category || "",
          project:   project  || "",
          vendor:    vendor   || "0",
          amount:    amount   || "",
          remarks:   remarks  || "",
          photos:    Array.isArray(photos) ? photos : [],
        },
      });
    }

    // ── ADD_DOCUMENTS → bill-submit → SUCCESS ─────────────────────────────────
    if (screen === "ADD_DOCUMENTS") {
      const { category, project, vendor, amount, remarks, photos, documents } = data;

      const now  = new Date();
      const date = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
      const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

      const allFiles = [
        ...(Array.isArray(photos)    ? photos    : []),
        ...(Array.isArray(documents) ? documents : []),
      ];

      const submitResult = await apiPostWithPhoneFallback("bill-submit", {
        date,
        on_time:     time,
        category_id: category,
        project_id:  project,
        supplier_id: (!vendor || vendor === "0") ? 0 : Number(vendor),
        amount:      Number(amount),
        remarks:     remarks || "",
        item:        JSON.stringify(allFiles),
      }, rawPhone);

      if (!submitResult) {
        return reply({ screen: "ADD_DOCUMENTS", data: { error_message: "Submission failed. Please try again." } });
      }

      const bill = submitResult;

      // Resolve labels from cache
      const cached    = flowDataCache.get(rawPhone) || {};
      const catLabel  = (cached.categories || []).find(c => c.id === String(category))?.title  || String(category);
      const projLabel = (cached.projects   || []).find(p => p.id === String(project))?.title   || String(project);
      const venLabel  = (!vendor || vendor === "0")
        ? "None"
        : (cached.vendors || []).find(v => v.id === String(vendor))?.title || String(vendor);

      // Save to MongoDB
      try {
        const Bill = require("../models/Bill");
        await Bill.create({
          source:      "whatsapp_flow",
          company:     bill.company_id  || null,
          project:     bill.project_id  || project,
          category:    bill.category_id || category,
          amount:      Number(amount),
          vendor:      venLabel,
          remarks:     remarks || "",
          status:      "Not Started",
          billId:      bill.ref_bill_no || bill.bill_no || null,
          attachments: [],
        });
      } catch (dbErr) {
        console.warn("[Flow] MongoDB save skipped:", dbErr.message);
      }

      return reply({
        screen: "SUCCESS",
        data: {
          ref_bill_no: String(bill.ref_bill_no || bill.bill_no || "—"),
          category:    catLabel,
          project:     projLabel,
          amount:      Number(amount).toLocaleString("en-IN"),
          vendor:      venLabel,
          files_count: `${allFiles.length} file(s)`,
        },
      });
    }

    return res.status(400).send("Unknown screen");

  } catch (err) {
    console.error("[Flow] Error:", err?.response?.data || err.message);
    return res.status(500).send("Server error");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// WEBHOOK VERIFICATION — GET /webhook/whatsapp
// ═════════════════════════════════════════════════════════════════════════════

router.get("/whatsapp", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.status(403).send("Forbidden");
});

// ═════════════════════════════════════════════════════════════════════════════
// RECEIVE WHATSAPP MESSAGES — POST /webhook/whatsapp
// ═════════════════════════════════════════════════════════════════════════════

router.post("/whatsapp", (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object !== "whatsapp_business_account") return;

  (async () => {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value    = change.value;
        const messages = value.messages;
        if (!messages || messages.length === 0) continue;
        const contactName = value.contacts?.[0]?.profile?.name || "";
        for (const message of messages) {
          try { await handleMessage(message.from, message, contactName); }
          catch (err) { console.error("WhatsApp handler error:", err); }
        }
      }
    }
  })().catch(console.error);
});

module.exports = router;