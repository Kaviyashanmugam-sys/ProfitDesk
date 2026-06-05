const { Router } = require("express");
const axios = require("axios");
const crypto = require("crypto");

const router = Router();

const VERIFY_TOKEN    = process.env.WHATSAPP_VERIFY_TOKEN    || "profitdesk_verify_token";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const FLOW_ID         = process.env.WHATSAPP_FLOW_ID;
const PRIVATE_KEY     = process.env.FLOW_PRIVATE_KEY || process.env.WHATSAPP_PRIVATE_KEY;
const CUSTOMER_API    = process.env.CUSTOMER_API_BASE_URL || "https://prod.thinksoft.in/profitdesk/api/site-engineer";
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
// EXTERNAL API HELPERS
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

// Try phone10 first, then phone91
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
      catMap:        {},    // category_id → label
      projMap:       {},    // project_id  → label
      vendorMap:     {},    // vendor_id   → label
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

  // Normalize key — handle literal \n in .env strings
  const normalizedKey = PRIVATE_KEY.replace(/\\n/g, "\n");

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(normalizedKey);
  } catch (err) {
    console.error("[decrypt] createPrivateKey failed:", err.message);
    throw new Error("Invalid private key: " + err.message);
  }

  let decryptedKey;
  try {
    decryptedKey = crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(encrypted_aes_key, "base64")
    );
  } catch (err) {
    console.error("[decrypt] RSA decrypt failed:", err.message);
    throw new Error("RSA decrypt failed: " + err.message);
  }

  const iv        = Buffer.from(initial_vector, "base64");
  const encrypted = Buffer.from(encrypted_flow_data, "base64");
  const TAG_LEN   = 16;
  const encData   = encrypted.subarray(0, encrypted.length - TAG_LEN);
  const authTag   = encrypted.subarray(encrypted.length - TAG_LEN);

  let decrypted;
  try {
    const decipher = crypto.createDecipheriv("aes-128-gcm", decryptedKey, iv);
    decipher.setAuthTag(authTag);
    decrypted = Buffer.concat([decipher.update(encData), decipher.final()]);
  } catch (err) {
    console.error("[decrypt] AES-GCM failed:", err.message);
    throw new Error("AES decrypt failed: " + err.message);
  }

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

// Opens Flow directly at BILL_FORM with pre-loaded dropdown data
async function sendFlowMessage(to, bodyText, billFormData) {
  const messagePayload = {
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
  };

  console.log("[sendFlowMessage] payload:", JSON.stringify(messagePayload, null, 2));

  try {
    const res = await axios.post(
      `${GRAPH_URL}/messages`,
      messagePayload,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
    console.log(`[sendFlowMessage] ✅ Flow sent to ${to} | msgId:${res.data?.messages?.[0]?.id}`);
  } catch (err) {
    const errData = err.response?.data;
    console.error("[sendFlowMessage] ❌ error:", JSON.stringify(errData || err.message, null, 2));
    console.error("[sendFlowMessage] status:", err.response?.status);
    await sendText(to, "❌ Could not open bill form. Please try again.\n\nError: " + (errData?.error?.message || err.message));
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
// LOAD BILL FORM DATA
// Uses: user-company-list → user-company-enable → category-list
//       user-project-list → vendor-list
// ═══════════════════════════════════════════════════════

async function loadBillFormData(rawPhone, session) {
  // 1. GET COMPANY LIST
  // POST user-company-list { phone }
  // Response: [{ value: 4, label: "Almino Constructions" }]
  const companies = await apiWithPhone("user-company-list", {}, rawPhone);
  if (!companies || companies.length === 0) {
    console.warn("[loadBillFormData] No companies found for", rawPhone);
    return null;
  }

  // Pick first company (extend for multi-company selection if needed)
  session.company_id    = String(companies[0].value ?? companies[0].id ?? "");
  session.company_label = String(companies[0].label || companies[0].name || "");
  console.log(`[loadBillFormData] company: ${session.company_id} - ${session.company_label}`);

  // 2. ENABLE USER IN COMPANY (user-company-enable)
  // POST user-company-enable { phone, company_id }
  // Activates the user session for the selected company
  await apiWithPhone("user-company-enable", { company_id: session.company_id }, rawPhone);

  // 3. LOAD DROPDOWNS IN PARALLEL
  // POST category-list     { phone }
  // POST user-project-list { phone, company_id }
  // POST vendor-list       { phone, company_id, category_id: "" }
  const [categories, projects, vendors] = await Promise.all([
    apiWithPhone("category-list",     {},                                        rawPhone),
    apiWithPhone("user-project-list", { company_id: session.company_id },        rawPhone),
    apiWithPhone("vendor-list",       { company_id: session.company_id, category_id: "" }, rawPhone),
  ]);

  // 4. MAP TO FLOW DROPDOWN FORMAT { id, title }
  const catOpts = (categories || []).map((c) => ({
    id:    String(c.value ?? c.id),
    title: String(c.label || c.name || "Unknown"),
  }));

  const projOpts = (projects || []).map((p) => ({
    id:    String(p.value ?? p.id),
    title: String(p.label || p.name || "Unknown"),
  }));

  // Filter out API's "Add New" (value:0), prepend our own "None"
  const vendorOpts = [
    { id: "0", title: "None" },
    ...(vendors || [])
      .filter((v) => String(v.value ?? v.id) !== "0")
      .map((v) => ({
        id:    String(v.value ?? v.id),
        title: String(v.label || v.name || "Unknown"),
      })),
  ];

  // 5. CACHE LABEL MAPS (for SUCCESS screen label resolution)
  catOpts.forEach((c)    => { session.catMap[c.id]    = c.title; });
  projOpts.forEach((p)   => { session.projMap[p.id]   = p.title; });
  vendorOpts.forEach((v) => { session.vendorMap[v.id] = v.title; });

  console.log(`[loadBillFormData] cats:${catOpts.length} projs:${projOpts.length} vendors:${vendorOpts.length}`);

  return {
    categories:    catOpts.length  > 0 ? catOpts  : [{ id: "0", title: "No categories found" }],
    projects:      projOpts.length > 0 ? projOpts : [{ id: "0", title: "No projects assigned" }],
    vendors:       vendorOpts,
    error_message: "",
  };
}

// ═══════════════════════════════════════════════════════
// FLOW SCREEN HANDLERS
// ═══════════════════════════════════════════════════════

// BILL_FORM → Next: Add Photos
// Payload: { category, project, vendor, amount, remarks }
function handleBillForm(payload) {
  const { category, project, vendor, amount, remarks } = payload;
  return {
    screen: "ADD_PHOTOS",
    data: {
      error_message: "",
      category:      String(category || ""),
      project:       String(project  || ""),
      vendor:        String(vendor   || "0"),
      amount:        String(amount   || ""),
      remarks:       String(remarks  || ""),
    },
  };
}

// ADD_PHOTOS → Next: Add Documents
// Payload: { photos, category, project, vendor, amount, remarks }
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

// ADD_DOCUMENTS → Submit Bill
// Payload: { documents, category, project, vendor, amount, remarks, photos }
// Uses: bill-submit { phone, company_id, date, on_time, project_id,
//                    supplier_id, category_id, amount, remarks, item }
async function handleAddDocuments(payload, session) {
  const rawPhone  = session.rawPhone;
  const documents = payload.documents || [];
  const photos    = payload.photos    || [];

  // Download all media as base64
  const allMedia = [...photos, ...documents].filter(Boolean);
  const files    = [];
  for (const media of allMedia) {
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

  console.log("[handleAddDocuments] bill-submit payload:", {
    company_id: session.company_id, category_id, project_id,
    supplier_id, amount, remarks, files: files.length, date, time,
  });

  // POST bill-submit
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

  // Submission failed — return error on same screen
  if (!result) {
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

  // Resolve labels for SUCCESS screen
  const catLabel   = session.catMap[category_id]   || category_id;
  const projLabel  = session.projMap[project_id]   || project_id;
  const vendLabel  = supplier_id === "0" ? "-" : (session.vendorMap[supplier_id] || supplier_id);
  const billNo     = result?.ref_bill_no || result?.bill_no || "-";
  const filesCount = files.length > 0 ? `${files.length} file(s)` : "None";

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
// MAIN MESSAGE HANDLER
// ═══════════════════════════════════════════════════════

async function handleMessage(from, message, contactName) {
  const session = getSession(from, contactName);
  console.log(`[handleMessage] from:${from} type:${message.type}`);

  if (message.type !== "text") return;

  const text  = String(message.text?.body || "").trim();
  const lower = text.toLowerCase();

  if (["hi", "hello", "hey", "hii", "hai", "start"].includes(lower)) {
    const name = session.name || contactName || "there";

    // Load all dropdown data (company-list → company-enable → category/project/vendor)
    const billFormData = await loadBillFormData(from, session);

    if (!billFormData) {
      await sendText(from,
        "❌ Your number is not registered in ProfitDesk.\nPlease contact your admin."
      );
      clearSession(from);
      return;
    }

    // Send greeting with Flow button — opens directly at BILL_FORM
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
// WEBHOOK GET — Meta verification
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
// WEBHOOK POST — incoming WhatsApp messages
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
// FLOW WEBHOOK POST — /webhook/flow
// ═══════════════════════════════════════════════════════

router.post("/flow", async (req, res) => {
  try {
    // Decrypt request
    let decryptedBody, aesKey, iv;
    try {
      ({ decryptedBody, aesKey, iv } = decryptFlowRequest(req.body));
    } catch (err) {
      console.error("[Flow] Decryption failed:", err.message);
      return res.status(421).send("Decryption failed");
    }

    console.log("[Flow] decrypted:", JSON.stringify(decryptedBody, null, 2));

    const { action, flow_token, data: flowData, screen } = decryptedBody;
    const rawPhone = flow_token;   // flow_token = phone10
    const session  = getSession(rawPhone, "");

    // ── ping ─────────────────────────────────────
    if (action === "ping") {
      return res.send(encryptFlowResponse({ data: { status: "active" } }, aesKey, iv));
    }

    // ── INIT (defensive fallback) ─────────────────
    // navigate mode la normally INIT call varaadhu
    // but Meta sometimes sends it — reload data and go to BILL_FORM
    if (action === "INIT") {
      const billFormData = await loadBillFormData(rawPhone, session);
      const payload = billFormData
        ? { screen: "BILL_FORM", data: billFormData }
        : {
            screen: "BILL_FORM",
            data: {
              categories:    [{ id: "0", title: "Error loading data" }],
              projects:      [{ id: "0", title: "Error loading data" }],
              vendors:       [{ id: "0", title: "None" }],
              error_message: "Could not load data. Please close and try again.",
            },
          };
      return res.send(encryptFlowResponse(payload, aesKey, iv));
    }

    // ── data_exchange ─────────────────────────────
    if (action === "data_exchange") {
      let responsePayload;

      if (screen === "BILL_FORM") {
        responsePayload = handleBillForm(flowData);

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