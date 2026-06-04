const { Router } = require("express");
const axios = require("axios");
const crypto = require("crypto");

const router = Router();

const VERIFY_TOKEN    = process.env.WHATSAPP_VERIFY_TOKEN    || "profitdesk_verify_token";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const FLOW_ID         = process.env.WHATSAPP_FLOW_ID;
const PRIVATE_KEY     = process.env.WHATSAPP_PRIVATE_KEY;   // PEM string
const CUSTOMER_API    = process.env.CUSTOMER_API_BASE_URL   || "https://prod.thinksoft.in/profitdesk/api/site-engineer";
const GRAPH_URL       = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}`;
const SESSION_TTL_MS  = 30 * 60 * 1000;

// ═══════════════════════════════════════════════════════
// PHONE HELPERS
// ═══════════════════════════════════════════════════════

function phone10(raw) {
  if (!raw) return "";
  return String(raw).replace(/\D/g, "").slice(-10);
}

function phone91(raw) {
  if (!raw) return "";
  const d = String(raw).replace(/\D/g, "");
  if (d.length === 10) return "91" + d;
  if (d.length === 12 && d.startsWith("91")) return d;
  return d;
}

// ═══════════════════════════════════════════════════════
// EXTERNAL API
// ═══════════════════════════════════════════════════════

async function apiPost(endpoint, body) {
  try {
    const res = await axios.post(`${CUSTOMER_API}/${endpoint}`, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });
    const d = res.data;
    if (d && String(d.status).toLowerCase() === "success") return d.data;
    console.warn(`[apiPost] ${endpoint} → status:${d?.status} | msg:${d?.message || "-"}`);
    return null;
  } catch (err) {
    console.error(`[apiPost] ${endpoint} error:`, err.message);
    return null;
  }
}

async function apiWithPhone(endpoint, extraBody, rawPhone) {
  const p10 = phone10(rawPhone);
  const p91 = phone91(rawPhone);
  let result = await apiPost(endpoint, { ...extraBody, phone: p10 });
  if (result && !(Array.isArray(result) && result.length === 0)) {
    console.log(`[apiPost] ${endpoint} matched phone10:${p10}`);
    return result;
  }
  result = await apiPost(endpoint, { ...extraBody, phone: p91 });
  if (result && !(Array.isArray(result) && result.length === 0)) {
    console.log(`[apiPost] ${endpoint} matched phone91:${p91}`);
    return result;
  }
  console.warn(`[apiPost] ${endpoint} no data for ${p10} / ${p91}`);
  return null;
}

// ═══════════════════════════════════════════════════════
// SESSION STORE
// ═══════════════════════════════════════════════════════

const sessions = new Map();

function getSession(rawPhone, name) {
  const key = phone10(rawPhone);
  const now = Date.now();
  const ex  = sessions.get(key);
  if (ex && now - ex.createdAt > SESSION_TTL_MS) sessions.delete(key);
  if (!sessions.has(key)) {
    sessions.set(key, {
      createdAt:     now,
      rawPhone,
      name:          name || "",
      company_id:    null,
      company_label: "",
      // dropdown label caches (for SUCCESS screen)
      catMap:        {},   // id → label
      projMap:       {},
      vendorMap:     {},
    });
  }
  const s = sessions.get(key);
  if (name && !s.name) s.name = name;
  return s;
}

function clearSession(rawPhone) {
  sessions.delete(phone10(rawPhone));
}

// ═══════════════════════════════════════════════════════
// ENCRYPTION  (AES-128-GCM)
// ═══════════════════════════════════════════════════════

function decryptFlowRequest(body) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;

  const privateKey   = crypto.createPrivateKey(PRIVATE_KEY);
  const decryptedKey = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(encrypted_aes_key, "base64")
  );

  const iv        = Buffer.from(initial_vector, "base64");
  const encrypted = Buffer.from(encrypted_flow_data, "base64");
  const TAG_LEN   = 16;
  const encData   = encrypted.subarray(0, encrypted.length - TAG_LEN);
  const authTag   = encrypted.subarray(encrypted.length - TAG_LEN);

  const decipher = crypto.createDecipheriv("aes-128-gcm", decryptedKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encData), decipher.final()]);

  return { decryptedBody: JSON.parse(decrypted.toString("utf8")), aesKey: decryptedKey, iv };
}

function encryptFlowResponse(responseObj, aesKey, iv) {
  const flippedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) flippedIv[i] = ~iv[i] & 0xff;

  const cipher    = crypto.createCipheriv("aes-128-gcm", aesKey, flippedIv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(responseObj), "utf8"), cipher.final()]);
  const authTag   = cipher.getAuthTag();

  return Buffer.concat([encrypted, authTag]).toString("base64");
}

// ═══════════════════════════════════════════════════════
// WHATSAPP SENDERS
// ═══════════════════════════════════════════════════════

async function sendText(to, text) {
  try {
    await axios.post(
      `${GRAPH_URL}/messages`,
      { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
  } catch (err) {
    console.error("[sendText] error:", err.response?.data || err.message);
  }
}

// Send flow message — opens directly at BILL_FORM with live dropdown data
async function sendFlowMessage(to, bodyText, billFormData) {
  try {
    await axios.post(
      `${GRAPH_URL}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        recipient_type: "individual",
        type: "interactive",
        interactive: {
          type: "flow",
          body: { text: bodyText },
          action: {
            name: "flow",
            parameters: {
              flow_message_version: "3",
              flow_token:           phone10(to),
              flow_id:              FLOW_ID,
              flow_cta:             "Create Bill",
              flow_action:          "navigate",
              flow_action_payload: {
                screen: "BILL_FORM",
                data:   billFormData,
              },
            },
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`[sendFlowMessage] Flow sent to ${to} → BILL_FORM`);
  } catch (err) {
    console.error("[sendFlowMessage] error:", err.response?.data || err.message);
    await sendText(to, "❌ Could not open the bill form. Please try again.");
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
      headers:      { Authorization: `Bearer ${ACCESS_TOKEN}` },
      responseType: "arraybuffer",
    });
    const mimeType = fileRes.headers["content-type"] || "image/jpeg";
    return `data:${mimeType};base64,${Buffer.from(fileRes.data).toString("base64")}`;
  } catch (err) {
    console.error("[downloadMedia] error:", err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════
// LOAD BILL FORM DATA  (called on "hi" trigger)
// ═══════════════════════════════════════════════════════

async function loadBillFormData(rawPhone, session) {
  // 1. Get company
  const companies = await apiWithPhone("user-company-list", {}, rawPhone);
  if (!companies || companies.length === 0) return null;

  if (companies.length === 1) {
    session.company_id    = String(companies[0].value ?? companies[0].id ?? "");
    session.company_label = String(companies[0].label || companies[0].name || "");
  } else {
    // Multiple companies — pick first for now (can extend later)
    session.company_id    = String(companies[0].value ?? companies[0].id ?? "");
    session.company_label = String(companies[0].label || companies[0].name || "");
  }

  // 2. Load categories, projects, vendors in parallel
  const [categories, projects, vendors] = await Promise.all([
    apiWithPhone("category-list",     {},                               rawPhone),
    apiWithPhone("user-project-list", { company_id: session.company_id }, rawPhone),
    apiWithPhone("vendor-list",       { company_id: session.company_id, category_id: "" }, rawPhone),
  ]);

  // 3. Build dropdown options
  const catOpts = (categories || []).map((c) => ({
    id:    String(c.value ?? c.id),
    title: String(c.label || c.name || "Unknown"),
  }));

  const projOpts = (projects || []).map((p) => ({
    id:    String(p.value ?? p.id),
    title: String(p.label || p.name || "Unknown"),
  }));

  // Filter out API's own "Add New" (value:0)
  const vendorOpts = [
    { id: "0", title: "None" },
    ...(vendors || [])
      .filter((v) => String(v.value ?? v.id) !== "0")
      .map((v) => ({
        id:    String(v.value ?? v.id),
        title: String(v.label || v.name || "Unknown"),
      })),
  ];

  // 4. Cache label maps for SUCCESS screen
  catOpts.forEach((c)    => { session.catMap[c.id]    = c.title; });
  projOpts.forEach((p)   => { session.projMap[p.id]   = p.title; });
  vendorOpts.forEach((v) => { session.vendorMap[v.id] = v.title; });

  return {
    categories:    catOpts.length  > 0 ? catOpts  : [{ id: "0", title: "No categories" }],
    projects:      projOpts.length > 0 ? projOpts : [{ id: "0", title: "No projects assigned" }],
    vendors:       vendorOpts,
    error_message: "",
  };
}

// ═══════════════════════════════════════════════════════
// FLOW SCREEN HANDLERS
// ═══════════════════════════════════════════════════════

// BILL_FORM → "Next: Add Photos"
// payload: { category, project, vendor, amount, remarks }
function handleBillForm(payload, session) {
  const { category, project, vendor, amount, remarks } = payload;

  return {
    screen: "ADD_PHOTOS",
    data: {
      error_message: "",
      category:      String(category  || ""),
      project:       String(project   || ""),
      vendor:        String(vendor    || "0"),
      amount:        String(amount    || ""),
      remarks:       String(remarks   || ""),
    },
  };
}

// ADD_PHOTOS → "Next: Add Documents"
// payload: { photos, category, project, vendor, amount, remarks }
function handleAddPhotos(payload) {
  return {
    screen: "ADD_DOCUMENTS",
    data: {
      error_message: "",
      category:      String(payload.category || ""),
      project:       String(payload.project  || ""),
      vendor:        String(payload.vendor   || "0"),
      amount:        String(payload.amount   || ""),
      remarks:       String(payload.remarks  || ""),
      photos:        payload.photos          || [],
    },
  };
}

// ADD_DOCUMENTS → "Submit Bill"
// payload: { documents, category, project, vendor, amount, remarks, photos }
async function handleAddDocuments(payload, session) {
  const rawPhone  = session.rawPhone;
  const documents = payload.documents || [];
  const photos    = payload.photos    || [];

  // Download all media (photos + documents) as base64
  const allMedia = [...photos, ...documents].filter(Boolean);
  const files    = [];

  for (const media of allMedia) {
    // WhatsApp Flow media objects have a cdn_url or file_name field
    const mediaId = media?.cdn_url || media?.file_name || media?.id || media;
    if (!mediaId || typeof mediaId !== "string") continue;
    const base64 = await downloadMedia(mediaId);
    if (base64) files.push({ id: Date.now() + Math.random(), document: base64 });
  }

  const now  = new Date();
  const date = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

  const category_id = String(payload.category || "");
  const project_id  = String(payload.project  || "");
  const supplier_id = String(payload.vendor   || "0");
  const amount      = payload.amount  || 0;
  const remarks     = payload.remarks || "";

  console.log("[handleAddDocuments] submitting:", {
    company_id: session.company_id, category_id, project_id,
    supplier_id, amount, remarks, files: files.length, date, time,
  });

  const result = await apiWithPhone(
    "bill-submit",
    {
      company_id:  session.company_id,
      date,
      on_time:     time,
      project_id,
      supplier_id: supplier_id === "0" ? 0 : supplier_id,
      category_id,
      amount,
      remarks,
      item:        JSON.stringify(files),
    },
    rawPhone
  );

  if (!result) {
    // Return to ADD_DOCUMENTS with error
    return {
      screen: "ADD_DOCUMENTS",
      data: {
        error_message: "Bill submission failed. Please try again.",
        category:      String(category_id),
        project:       String(project_id),
        vendor:        String(supplier_id),
        amount:        String(amount),
        remarks:       String(remarks),
        photos,
      },
    };
  }

  // Resolve labels from cached maps
  const catLabel    = session.catMap[category_id]   || category_id;
  const projLabel   = session.projMap[project_id]   || project_id;
  const vendLabel   = supplier_id === "0" ? "-" : (session.vendorMap[supplier_id] || supplier_id);
  const billNo      = result?.ref_bill_no || result?.bill_no || "-";
  const filesCount  = files.length > 0 ? `${files.length} file(s)` : "None";

  clearSession(rawPhone);

  return {
    screen: "SUCCESS",
    data: {
      ref_bill_no: String(billNo),
      category:    catLabel,
      project:     projLabel,
      amount:      Number(amount).toLocaleString("en-IN"),
      vendor:      vendLabel,
      files_count: filesCount,
    },
  };
}

// ═══════════════════════════════════════════════════════
// MAIN WHATSAPP MESSAGE HANDLER
// ═══════════════════════════════════════════════════════

async function handleMessage(from, message, contactName) {
  const session = getSession(from, contactName);
  console.log(`[handleMessage] from:${from} type:${message.type}`);

  if (message.type !== "text") return;

  const text  = String(message.text?.body || "").trim();
  const lower = text.toLowerCase();

  if (["hi", "hello", "hey", "hii", "hai", "start"].includes(lower)) {
    const name = session.name || contactName || "there";

    // Load all dropdown data upfront
    const billFormData = await loadBillFormData(from, session);

    if (!billFormData) {
      await sendText(from,
        "❌ Your number is not registered in ProfitDesk.\nPlease contact your admin."
      );
      clearSession(from);
      return;
    }

    // Send greeting + flow button — flow opens directly at BILL_FORM
    await sendFlowMessage(
      from,
      `Hi ${name}! 👋 Welcome to *ProfitDesk*.\nTap *Create Bill* to submit a new bill.`,
      billFormData
    );

  } else {
    await sendText(from, "👋 Send *hi* to get started with ProfitDesk.");
  }
}

// ═══════════════════════════════════════════════════════
// WEBHOOK — GET  (Meta verification)
// ═══════════════════════════════════════════════════════

router.get("/whatsapp", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).send("Forbidden");
  }
});

// ═══════════════════════════════════════════════════════
// WEBHOOK — POST  (incoming messages)
// ═══════════════════════════════════════════════════════

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
          try {
            await handleMessage(message.from, message, contactName);
          } catch (err) {
            console.error("[WhatsApp handler error]:", err);
          }
        }
      }
    }
  })().catch(console.error);
});

// ═══════════════════════════════════════════════════════
// FLOW WEBHOOK — POST /webhook/flow
// ═══════════════════════════════════════════════════════

router.post("/flow", async (req, res) => {
  try {
    // Decrypt
    let decryptedBody, aesKey, iv;
    try {
      ({ decryptedBody, aesKey, iv } = decryptFlowRequest(req.body));
    } catch (err) {
      console.error("[Flow] Decryption failed:", err.message);
      return res.status(421).send("Decryption failed");
    }

    console.log("[Flow] decrypted:", JSON.stringify(decryptedBody, null, 2));

    const { action, flow_token, data: flowData, screen } = decryptedBody;
    const rawPhone = flow_token; // flow_token = phone10
    const session  = getSession(rawPhone, "");

    // ── ping ─────────────────────────────────────────
    if (action === "ping") {
      return res.send(encryptFlowResponse({ data: { status: "active" } }, aesKey, iv));
    }

    // ── INIT ─────────────────────────────────────────
    // Should not normally be called since we use navigate mode,
    // but handle defensively — reload data and go to BILL_FORM
    if (action === "INIT") {
      const billFormData = await loadBillFormData(rawPhone, session);
      const responsePayload = billFormData
        ? { screen: "BILL_FORM", data: billFormData }
        : { screen: "BILL_FORM", data: {
            categories: [{ id: "0", title: "Error loading" }],
            projects:   [{ id: "0", title: "Error loading" }],
            vendors:    [{ id: "0", title: "None" }],
            error_message: "Could not load data. Please close and try again.",
          }};
      return res.send(encryptFlowResponse(responsePayload, aesKey, iv));
    }

    // ── data_exchange ─────────────────────────────────
    if (action === "data_exchange") {
      let responsePayload;

      if (screen === "BILL_FORM") {
        responsePayload = handleBillForm(flowData, session);

      } else if (screen === "ADD_PHOTOS") {
        responsePayload = handleAddPhotos(flowData);

      } else if (screen === "ADD_DOCUMENTS") {
        responsePayload = await handleAddDocuments(flowData, session);

      } else {
        console.warn("[Flow] Unknown screen:", screen);
        responsePayload = {
          screen: "BILL_FORM",
          data: {
            categories:    [],
            projects:      [],
            vendors:       [{ id: "0", title: "None" }],
            error_message: "Something went wrong. Please try again.",
          },
        };
      }

      return res.send(encryptFlowResponse(responsePayload, aesKey, iv));
    }

    console.warn("[Flow] Unknown action:", action);
    return res.status(400).send("Unknown action");

  } catch (err) {
    console.error("[Flow] Unhandled error:", err);
    return res.status(500).send("Internal error");
  }
});

module.exports = router;