const { Router } = require("express");
const axios  = require("axios");
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
const LOGO_URL         = "https://res.cloudinary.com/dxfphwvnf/image/upload/logo_hc2qsg";

// ─── Phone helpers ────────────────────────────────────────────────────────────
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

// ─── Flow encryption ─────────────────────────────────────────────────────────
function decryptFlowRequest(body) {
  const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;
  const rawKey = (FLOW_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const pk = crypto.createPrivateKey(rawKey);
  const aesKey = crypto.privateDecrypt(
    { key: pk, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(encrypted_aes_key, "base64")
  );
  const iv  = Buffer.from(initial_vector, "base64");
  const enc = Buffer.from(encrypted_flow_data, "base64");
  const tag = enc.slice(-16);
  const ct  = enc.slice(0, -16);
  const dc  = crypto.createDecipheriv("aes-128-gcm", aesKey, iv);
  dc.setAuthTag(tag);
  return { decryptedBody: JSON.parse(Buffer.concat([dc.update(ct), dc.final()]).toString()), aesKey, iv };
}

function encryptFlowResponse(obj, aesKey, iv) {
  const flipped = Buffer.from(iv.map(b => ~b & 0xff));
  const c = crypto.createCipheriv("aes-128-gcm", aesKey, flipped);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([enc, c.getAuthTag()]).toString("base64");
}

// ─── Dropdown helpers ─────────────────────────────────────────────────────────
function toDropdownItem(item) {
  return {
    id:    String(item.value ?? item.id ?? ""),
    title: String(item.label || item.title || item.name || "Unknown"),
  };
}
function findName(list, id) {
  if (!list || !id) return String(id || "");
  const item = list.find(i => String(i.value ?? i.id ?? "") === String(id));
  return item ? String(item.label || item.title || item.name || id) : String(id);
}

// ─── Session & pending bills ──────────────────────────────────────────────────
const sessions     = new Map();
const pendingBills = new Map();

function getSession(from, name) {
  const now = Date.now();
  const ex  = sessions.get(from);
  if (ex && now - ex.createdAt > SESSION_TTL_MS) sessions.delete(from);
  if (!sessions.has(from)) {
    sessions.set(from, {
      createdAt: now, step: "START",
      phone: phone10(from), rawPhone: from, name: name || "",
      company_id: null, company_label: "",
      category_id: null, category_label: "",
      project_id: null, project_label: "",
      supplier_id: 0, supplier_label: "",
      amount: null, remarks: "",
      files: [], companies: [], categories: [], projects: [], vendors: [],
    });
  }
  const s = sessions.get(from);
  if (name && !s.name) s.name = name;
  return s;
}
function clearSession(from) { sessions.delete(from); }

// ─── External API ─────────────────────────────────────────────────────────────
async function apiPost(endpoint, body) {
  try {
    const res = await axios.post(`${CUSTOMER_API}/${endpoint}`, body, {
      headers: { "Content-Type": "application/json" }, timeout: 15000,
    });
    if (res.data && String(res.data.status).toLowerCase() === "success") return res.data.data;
    console.warn(`[apiPost] ${endpoint} → ${res.data?.status} | ${res.data?.message}`);
    return null;
  } catch (err) {
    console.error(`[apiPost] ${endpoint} error:`, err.message);
    return null;
  }
}

async function apiPostWithPhoneFallback(endpoint, baseBody, rawPhone) {
  const p10 = phone10(rawPhone), p91 = phone91(rawPhone);
  let r = await apiPost(endpoint, { ...baseBody, phone: p10 });
  if (r) { console.log(`[apiPost] ${endpoint} matched phone10: ${p10}`); return r; }
  r = await apiPost(endpoint, { ...baseBody, phone: p91 });
  if (r) { console.log(`[apiPost] ${endpoint} matched phone91: ${p91}`); return r; }
  console.warn(`[apiPost] ${endpoint} failed for ${p10} and ${p91}`);
  return null;
}

async function fetchDropdowns(rawPhone) {
  const companyRes = await apiPostWithPhoneFallback("user-company-list", {}, rawPhone);
  const company    = companyRes?.[0];
  const companyId  = company ? Number(company.value ?? company.id) : 0;
  const [catRes, projRes, vendRes] = await Promise.all([
    apiPostWithPhoneFallback("category-list",     {},                                         rawPhone),
    apiPostWithPhoneFallback("user-project-list", { company_id: companyId },                  rawPhone),
    apiPostWithPhoneFallback("vendor-list",       { company_id: companyId, category_id: 1 }, rawPhone),
  ]);
  const categories = Array.isArray(catRes)  ? catRes.map(toDropdownItem)  : [];
  const projects   = Array.isArray(projRes) ? projRes.map(toDropdownItem) : [];
  const vendItems  = Array.isArray(vendRes) ? vendRes.filter(v => String(v.value ?? v.id) !== "0").map(toDropdownItem) : [];
  const vendors    = [{ id: "0", title: "None" }, ...vendItems];
  if (!categories.length) categories.push({ id: "err", title: "No categories found" });
  if (!projects.length)   projects.push(  { id: "err", title: "No projects found"   });
  return { categories, projects, vendors, companyId, catList: catRes, projList: projRes, vendList: vendRes };
}

// ─── WhatsApp senders ─────────────────────────────────────────────────────────
async function sendText(to, text) {
  await axios.post(`${GRAPH_URL}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

async function sendButtons(to, body, buttons) {
  await axios.post(`${GRAPH_URL}/messages`, {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "button", body: { text: body },
      action: { buttons: buttons.slice(0, 3).map(b => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
}

async function sendList(to, bodyText, buttonLabel, items) {
  await axios.post(`${GRAPH_URL}/messages`, {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "list", body: { text: bodyText },
      action: { button: buttonLabel, sections: [{ title: "Options", rows: items.slice(0, 10).map(i => ({ id: String(i.value || i.id), title: String(i.label || i.title || i.name).slice(0, 24) })) }] },
    },
  }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
}

async function sendMenu(to, bodyText, label, items) {
  if (items.length <= 3) await sendButtons(to, bodyText, items.map(i => ({ id: String(i.value || i.id), title: String(i.label || i.title || i.name) })));
  else await sendList(to, bodyText, label, items);
}

async function sendFlow(to, flowToken, rawPhone, bodyText) {
  const { categories, projects, vendors } = await fetchDropdowns(rawPhone);
  await axios.post(`${GRAPH_URL}/messages`, {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "flow", body: { text: bodyText },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3", flow_token: flowToken,
          flow_id: FLOW_ID, flow_cta: "Open Bill Form", flow_action: "navigate",
          flow_action_payload: { screen: "BILL_FORM", data: { categories, projects, vendors, error_message: "" } },
        },
      },
    },
  }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
}

// ─── Razorpay payment link ────────────────────────────────────────────────────
async function createPaymentLink(amount, billNo, catName, projName) {
  try {
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
    const res  = await axios.post("https://api.razorpay.com/v1/payment_links", {
      amount:          Math.round(Number(amount) * 100),
      currency:        "INR",
      description:     `Bill ${billNo} - ${catName}`,
      notify:          { sms: false, email: false },
      reminder_enable: false,
      notes:           { bill_no: billNo, category: catName, project: projName },
    }, { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" } });
    return res.data.short_url;
  } catch (err) {
    console.warn("[Razorpay] Failed:", err.response?.data || err.message);
    return null;
  }
}

// ─── Chat flow steps ──────────────────────────────────────────────────────────
async function stepWelcome(from, session) {
  const companies = await apiPostWithPhoneFallback("user-company-list", {}, session.rawPhone);
  if (!companies || companies.length === 0) {
    await sendText(from, "Your number is not registered in ProfitDesk. Please contact your admin.");
    clearSession(from); return;
  }
  session.companies = companies;
  const name = session.name || "there";

  // Send logo
  try {
    await axios.post(`${GRAPH_URL}/messages`, {
      messaging_product: "whatsapp", to: from, type: "image",
      image: { link: LOGO_URL, caption: `Hi ${name}, Welcome to ProfitDesk!\n\nWE TRACK YOUR SITE, YOU TRACK YOUR GROWTH.` },
    }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    console.log("[stepWelcome] logo sent ✅");
  } catch (e) {
    console.warn("[stepWelcome] logo failed:", e.message);
  }

  await sendFlow(from, phone91(from), session.rawPhone, `Hi ${name}, Welcome to ProfitDesk!\n\nClick below to create a new bill.`);
  session.step = "FLOW_SENT";
}

async function handleMessage(from, message, contactName) {
  const session = getSession(from, contactName);

  if (["image", "document", "video", "audio"].includes(message.type)) {
    if (session.step === "PHOTO") {
      const mediaId = message.image?.id || message.document?.id || message.video?.id;
      if (mediaId) {
        await sendText(from, "Processing file...");
        try {
          const urlRes  = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
          const fileRes = await axios.get(urlRes.data.url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, responseType: "arraybuffer" });
          const base64  = `data:${fileRes.headers["content-type"] || "image/jpeg"};base64,${Buffer.from(fileRes.data).toString("base64")}`;
          session.files.push({ id: Date.now(), document: base64 });
          await sendText(from, `File ${session.files.length} received! Send more or type done.`);
        } catch { await sendText(from, "Could not process file. Try again or type done."); }
      }
      return;
    }
    await sendText(from, "Type cancel to restart."); return;
  }

  if (message.type === "interactive") {
    const iType = message.interactive.type;
    const selectedId = iType === "button_reply" ? message.interactive.button_reply.id
                     : iType === "list_reply"   ? message.interactive.list_reply.id : "";

    // Submit Another Bill
    if (selectedId === "submit_another_bill") {
      clearSession(from); pendingBills.delete(from);
      const ns = getSession(from, contactName); ns.step = "FLOW_SENT";
      await sendFlow(from, phone91(from), from, "Tap to submit another bill.");
      return;
    }

    // Confirm & Submit
    if (selectedId === "confirm_submit") {
      const pending = pendingBills.get(from);
      if (!pending) { await sendText(from, "Session expired. Send hi to restart."); return; }
      pendingBills.delete(from);
      session.step = "SUBMITTING";

      const now  = new Date();
      const date = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
      const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

      const submitResult = await apiPostWithPhoneFallback("bill-submit", {
        company_id:  pending.companyId,
        date, on_time: time,
        category_id: pending.category,
        project_id:  pending.project,
        supplier_id: (!pending.vendor || pending.vendor === "0") ? 0 : Number(pending.vendor),
        amount:      Number(pending.amount),
        remarks:     pending.remarks || "",
        item:        JSON.stringify(pending.allFiles),
      }, from);

      if (submitResult) {
        const bill     = typeof submitResult === "object" ? submitResult : {};
        const billNo   = bill.ref_bill_no || "—";
        const catName  = bill.category || pending.catName;
        const projName = bill.project  || pending.projName;
        const vendName = bill.vendor   || pending.vendName;

        setImmediate(async () => {
          try {
            const Bill = require("../models/Bill");
            await Bill.create({ source: "whatsapp_flow", category: catName, amount: Number(pending.amount), vendor: vendName, remarks: pending.remarks || "", status: "Not Started", attachments: [] });
          } catch (e) { console.warn("[MongoDB] save skipped:", e.message); }
        });

        clearSession(from);
        await sendButtons(from,
          `✅ Bill Submitted Successfully!\n\n` +
          `Bill No: ${billNo}\n` +
          `Category: ${catName}\n` +
          `Project:  ${projName}\n` +
          `Vendor:   ${vendName}\n` +
          `Amount:   Rs.${Number(pending.amount).toLocaleString("en-IN")}\n` +
          `Files:    ${pending.allFiles.length} file(s)\n\n` +
          `Tap below to submit another bill.`,
          [{ id: "submit_another_bill", title: "Submit Another Bill" }]
        );
      } else {
        await sendText(from, "❌ Submission failed. Send hi to restart.");
        clearSession(from);
      }
      return;
    }

    // Cancel
    if (selectedId === "cancel_submit") {
      pendingBills.delete(from); clearSession(from);
      await sendText(from, "Bill cancelled. Send hi to start again.");
      return;
    }

    return;
  }

  const text  = String(message.text?.body || "").trim();
  const lower = text.toLowerCase();

  if (lower === "cancel") { clearSession(from); pendingBills.delete(from); await sendText(from, "Cancelled. Send hi to start again."); return; }

  switch (session.step) {
    case "START":
      if (["hi","hello","hey","hii","hai","helo"].includes(lower)) await stepWelcome(from, session);
      else await sendText(from, "Send hi to get started with ProfitDesk.");
      break;
    case "FLOW_SENT":
      if (["hi","hello"].includes(lower)) { clearSession(from); await stepWelcome(from, getSession(from, contactName)); }
      else await sendText(from, "Please fill the bill form above. Type cancel to restart.");
      break;
    default:
      if (["hi","hello"].includes(lower)) { clearSession(from); await stepWelcome(from, getSession(from, contactName)); }
      else await sendText(from, "Send hi to get started.");
  }
}

// ─── Flow webhook ─────────────────────────────────────────────────────────────
router.post("/flow", async (req, res) => {
  console.log(`\n📋 Flow webhook | keys=${Object.keys(req.body).join(",")}`);
  try {
    let decryptedBody, aesKey, iv;
    try {
      const r = decryptFlowRequest(req.body);
      decryptedBody = r.decryptedBody; aesKey = r.aesKey; iv = r.iv;
    } catch (e) { console.error("[Flow] Decrypt error:", e.message); return res.status(421).send("Decryption failed"); }

    const { screen, data = {}, flow_token, action } = decryptedBody;
    const rawPhone = flow_token || "";
    console.log(`📋 screen=${screen || "INIT"} | action=${action} | phone=${rawPhone}`);

    const reply = obj => {
      const enc = encryptFlowResponse(obj, aesKey, iv);
      return res.status(200).send(enc);
    };

    if (action === "ping") return reply({ data: { status: "active" } });

    // INIT
    if (action === "INIT" || !screen || screen === "INIT") {
      const { categories, projects, vendors } = await fetchDropdowns(rawPhone);
      return reply({ screen: "BILL_FORM", data: { categories, projects, vendors, error_message: "" } });
    }

    // BILL_FORM → ADD_PHOTOS
    if (screen === "BILL_FORM") {
      const { category, project, amount, vendor, remarks } = data;
      if (!category || !project || !amount) return reply({ screen: "BILL_FORM", data: { error_message: "Category, Project and Amount are required." } });
      if (isNaN(Number(amount)) || Number(amount) <= 0) return reply({ screen: "BILL_FORM", data: { error_message: "Please enter a valid amount." } });
      return reply({ screen: "ADD_PHOTOS", data: { error_message: "", category, project, vendor: vendor || "0", amount: String(amount), remarks: remarks || "" } });
    }

    // ADD_PHOTOS → ADD_DOCUMENTS
    if (screen === "ADD_PHOTOS") {
      const { category, project, vendor, amount, remarks, photos } = data;
      return reply({ screen: "ADD_DOCUMENTS", data: { error_message: "", category, project, vendor: vendor || "0", amount: amount || "", remarks: remarks || "", photos: Array.isArray(photos) ? photos : [] } });
    }

    // ADD_DOCUMENTS → summary with pay link (optional)
    if (screen === "ADD_DOCUMENTS") {
      const { category, project, vendor, amount, remarks, photos, documents } = data;
      const allFiles = [...(Array.isArray(photos) ? photos : []), ...(Array.isArray(documents) ? documents : [])];

      const { catList, projList, vendList, companyId } = await fetchDropdowns(rawPhone);
      const catName  = findName(catList,  category);
      const projName = findName(projList, project);
      const vendName = (!vendor || vendor === "0") ? "None" : findName(vendList, vendor);

      console.log(`[ADD_DOCUMENTS] cat=${catName} proj=${projName} vendor=${vendName} amount=${amount} files=${allFiles.length}`);

      // Store pending
      const userPhone = phone91(rawPhone);
      pendingBills.set(userPhone, { category, project, vendor, amount, remarks, allFiles, catName, projName, vendName, companyId });
      const session = getSession(userPhone);
      session.step  = "CONFIRMING";

      // Try Razorpay payment link (optional)
      const payLink = await createPaymentLink(amount, "Pending", catName, projName);

      const summaryText =
        `📋 Bill Summary\n\n` +
        `Category: ${catName}\n` +
        `Project:  ${projName}\n` +
        `Vendor:   ${vendName}\n` +
        `Amount:   Rs.${Number(amount).toLocaleString("en-IN")}\n` +
        `Remarks:  ${remarks || "-"}\n` +
        `Files:    ${allFiles.length} file(s)` +
        (payLink ? `\n\n💳 Pay Now (optional):\n${payLink}` : "") +
        `\n\nPlease confirm to submit.`;

      try {
        await sendButtons(userPhone, summaryText, [
          { id: "confirm_submit", title: "✅ Confirm & Submit" },
          { id: "cancel_submit",  title: "❌ Cancel" },
        ]);
      } catch (e) { console.warn("[Flow] Summary failed:", e.message); }

      return reply({ screen: "SUCCESS", data: {} });
    }

    if (screen === "SUCCESS") return reply({ data: { status: "ok" } });

    return res.status(400).send("Unknown screen");
  } catch (err) {
    console.error("[Flow] Unhandled error:", err?.response?.data || err.message);
    return res.status(500).send("Server error");
  }
});

// ─── WhatsApp webhook ─────────────────────────────────────────────────────────
router.get("/whatsapp", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.status(403).send("Forbidden");
});

router.post("/whatsapp", (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object !== "whatsapp_business_account") return;
  (async () => {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const messages = change.value?.messages;
        if (!messages?.length) continue;
        const contactName = change.value?.contacts?.[0]?.profile?.name || "";
        for (const msg of messages) {
          try { await handleMessage(msg.from, msg, contactName); }
          catch (e) { console.error("Handler error:", e); }
        }
      }
    }
  })().catch(console.error);
});

module.exports = router;