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

function decryptFlowRequest(body) {
  const { encrypted_flow_data, encrypted_aes_key, initial_vector } = body;
  const rawKey      = (FLOW_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const privateKey  = crypto.createPrivateKey(rawKey);
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
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return { decryptedBody: JSON.parse(decrypted.toString("utf8")), aesKey: decryptedAesKey, iv };
}

function encryptFlowResponse(responseObj, aesKey, iv) {
  const flippedIv = Buffer.from(iv.map((b) => ~b & 0xff));
  const cipher    = crypto.createCipheriv("aes-128-gcm", aesKey, flippedIv);
  const jsonStr   = JSON.stringify(responseObj);
  const encrypted = Buffer.concat([cipher.update(jsonStr, "utf8"), cipher.final()]);
  const tag       = cipher.getAuthTag();
  return Buffer.concat([encrypted, tag]).toString("base64");
}

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
    item.name || item.label || item.title ||
    item.category_name || item.project_name ||
    item.vendor_name || item.supplier_name || item.company_name || "Unknown"
  );
  return { id, title };
}

function findName(list, id) {
  if (!list || !id) return String(id || "");
  const item = list.find(i => {
    const itemId = String(i.id ?? i.value ?? i.category_id ?? i.project_id ?? i.supplier_id ?? i.vendor_id ?? "");
    return itemId === String(id);
  });
  if (!item) return String(id);
  return String(item.name || item.category_name || item.project_name || item.vendor_name || item.supplier_name || item.title || id);
}

const sessions     = new Map();
const lastBillData = new Map();

function getSession(from, name) {
  const now = Date.now();
  const existing = sessions.get(from);
  if (existing && now - existing.createdAt > SESSION_TTL_MS) sessions.delete(from);
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
  const session = sessions.get(from);
  if (name && !session.name) session.name = name;
  return session;
}

function clearSession(from) { sessions.delete(from); }

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
      action: { buttons: buttons.slice(0, 3).map((b) => ({ type: "reply", reply: { id: b.id, title: b.title.slice(0, 20) } })) },
    },
  }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
}

async function sendList(to, bodyText, buttonLabel, items) {
  await axios.post(`${GRAPH_URL}/messages`, {
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "list", body: { text: bodyText },
      action: {
        button: buttonLabel,
        sections: [{ title: "Options", rows: items.slice(0, 10).map((item) => ({ id: String(item.value || item.id), title: String(item.label || item.title || item.name).slice(0, 24) })) }],
      },
    },
  }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
}

async function sendMenu(to, bodyText, label, items) {
  if (items.length <= 3) {
    await sendButtons(to, bodyText, items.map((i) => ({ id: String(i.value || i.id), title: String(i.label || i.title || i.name) })));
  } else {
    await sendList(to, bodyText, label, items);
  }
}

async function sendFlowMessage(to, flowToken, rawPhone, userName, prefillRemarks) {
  console.log(`[sendFlowMessage] to=${to} | flow_token=${flowToken} | FLOW_ID=${FLOW_ID}`);
  try {
    const companyRes  = await apiPostWithPhoneFallback("user-company-list", {}, rawPhone);
    const company     = companyRes?.[0];
    const companyId   = company ? Number(company.value ?? company.id) : 0;

    const [categoryRes, projectRes, vendorRes] = await Promise.all([
      apiPostWithPhoneFallback("category-list",     {},                                         rawPhone),
      apiPostWithPhoneFallback("user-project-list", { company_id: companyId },                  rawPhone),
      apiPostWithPhoneFallback("vendor-list",       { company_id: companyId, category_id: 1 }, rawPhone),
    ]);

    const categories  = Array.isArray(categoryRes) ? categoryRes.map(toDropdownItem) : [];
    const projects    = Array.isArray(projectRes)  ? projectRes.map(toDropdownItem)  : [];
    const vendorItems = Array.isArray(vendorRes) ? vendorRes.filter((v) => String(v.value ?? v.id) !== "0").map(toDropdownItem) : [];
    const vendors     = [{ id: "0", title: "None" }, ...vendorItems];

    if (categories.length === 0) categories.push({ id: "err", title: "No categories found" });
    if (projects.length   === 0) projects.push(  { id: "err", title: "No projects found"   });

    console.log(`[sendFlowMessage] cats=${categories.length} projs=${projects.length} vendors=${vendors.length}`);

    await axios.post(`${GRAPH_URL}/messages`, {
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: {
        type: "flow",
        body: { text: `Hi ${userName || "there"}, Welcome to ProfitDesk!\n\nClick below to create a new bill.` },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token:           flowToken,
            flow_id:              FLOW_ID,
            flow_cta:             "Open Bill Form",
            flow_action:          "navigate",
            flow_action_payload:  {
              screen: "BILL_FORM",
              data: { categories, projects, vendors, error_message: "", init_remarks: prefillRemarks || "" },
            },
          },
        },
      },
    }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    console.log(`[sendFlowMessage] ✅ sent successfully`);
  } catch (err) {
    console.error(`[sendFlowMessage] ❌ status=${err.response?.status}`);
    console.error(`[sendFlowMessage] ❌ error=`, JSON.stringify(err.response?.data, null, 2));
  }
}

// ✅ Send flow directly without greeting message
async function sendFlowDirect(to, flowToken, rawPhone) {
  console.log(`[sendFlowDirect] to=${to} | FLOW_ID=${FLOW_ID}`);
  try {
    const companyRes  = await apiPostWithPhoneFallback("user-company-list", {}, rawPhone);
    const company     = companyRes?.[0];
    const companyId   = company ? Number(company.value ?? company.id) : 0;

    const [categoryRes, projectRes, vendorRes] = await Promise.all([
      apiPostWithPhoneFallback("category-list",     {},                                         rawPhone),
      apiPostWithPhoneFallback("user-project-list", { company_id: companyId },                  rawPhone),
      apiPostWithPhoneFallback("vendor-list",       { company_id: companyId, category_id: 1 }, rawPhone),
    ]);

    const categories  = Array.isArray(categoryRes) ? categoryRes.map(toDropdownItem) : [];
    const projects    = Array.isArray(projectRes)  ? projectRes.map(toDropdownItem)  : [];
    const vendorItems = Array.isArray(vendorRes) ? vendorRes.filter((v) => String(v.value ?? v.id) !== "0").map(toDropdownItem) : [];
    const vendors     = [{ id: "0", title: "None" }, ...vendorItems];

    if (categories.length === 0) categories.push({ id: "err", title: "No categories found" });
    if (projects.length   === 0) projects.push(  { id: "err", title: "No projects found"   });

    const prefill = lastBillData.get(to) || {};

    await axios.post(`${GRAPH_URL}/messages`, {
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: {
        type: "flow",
        body: { text: "Tap to submit another bill." },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token:           flowToken,
            flow_id:              FLOW_ID,
            flow_cta:             "Open Bill Form",
            flow_action:          "navigate",
            flow_action_payload:  {
              screen: "BILL_FORM",
              data: { categories, projects, vendors, error_message: "", init_remarks: prefill.remarks || "" },
            },
          },
        },
      },
    }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    console.log(`[sendFlowDirect] ✅ sent`);
  } catch (err) {
    console.error(`[sendFlowDirect] ❌`, err.response?.data || err.message);
  }
}

async function downloadMedia(mediaId) {
  try {
    const urlRes  = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
    const mediaUrl = urlRes.data && urlRes.data.url;
    if (!mediaUrl) return null;
    const fileRes = await axios.get(mediaUrl, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }, responseType: "arraybuffer" });
    const mimeType = fileRes.headers["content-type"] || "image/jpeg";
    return `data:${mimeType};base64,${Buffer.from(fileRes.data).toString("base64")}`;
  } catch { return null; }
}

async function stepWelcome(from, session) {
  const companies = await apiPostWithPhoneFallback("user-company-list", {}, session.rawPhone);
  if (!companies || companies.length === 0) {
    await sendText(from, "Your number is not registered in ProfitDesk. Please contact your admin.");
    clearSession(from); return;
  }
  session.companies = companies;
  const name = session.name || "there";
  if (FLOW_ID) {
    const prefill = lastBillData.get(from) || {};
    await sendFlowMessage(from, phone91(from), session.rawPhone, name, prefill.remarks || "");
    session.step = "FLOW_SENT"; return;
  }
  session.step = "WELCOME";
  await sendButtons(from, `Hi ${name}, Welcome to ProfitDesk!\n\nClick below to create a new bill.`, [{ id: "create_bill", title: "Create Bill" }]);
}

async function stepCompany(from, session) {
  if (session.companies.length === 1) {
    session.company_id    = session.companies[0].value || session.companies[0].id;
    session.company_label = session.companies[0].label || session.companies[0].name;
    await stepCategory(from, session); return;
  }
  session.step = "COMPANY";
  await sendMenu(from, "Select your company:", "Select Company", session.companies);
}

async function stepCategory(from, session) {
  const categories = await apiPostWithPhoneFallback("category-list", {}, session.rawPhone);
  if (!categories || categories.length === 0) { await sendText(from, "No categories found. Please contact admin."); clearSession(from); return; }
  session.categories = categories; session.step = "CATEGORY";
  await sendMenu(from, "Select bill category:", "Select Category", categories);
}

async function stepProject(from, session) {
  const projects = await apiPostWithPhoneFallback("user-project-list", {}, session.rawPhone);
  if (!projects || projects.length === 0) { await sendText(from, "No projects found. Please contact admin."); clearSession(from); return; }
  session.projects = projects; session.step = "PROJECT";
  await sendMenu(from, "Select your project:", "Select Project", projects);
}

async function stepAmount(from, session) {
  session.step = "AMOUNT";
  await sendText(from, `Category: ${session.category_label}\nProject: ${session.project_label}\n\nEnter the bill amount (numbers only):\nExample: 5000`);
}

async function stepVendor(from, session) {
  const vendors = await apiPostWithPhoneFallback("vendor-list", { company_id: session.company_id, category_id: session.category_id }, session.rawPhone);
  if (!vendors || vendors.length === 0) { session.supplier_id = 0; session.supplier_label = "-"; await stepRemarks(from, session); return; }
  session.vendors = vendors; session.step = "VENDOR";
  await sendMenu(from, "Select vendor / supplier:", "Select Vendor", vendors);
}

async function stepRemarks(from, session) {
  session.step = "REMARKS";
  await sendText(from, "Enter remarks (or type skip to continue without remarks):");
}

async function stepPhoto(from, session) {
  session.step = "PHOTO";
  await sendText(from, "Send bill photos, PDFs, or documents (optional).\n\nSend multiple files one by one.\nType done when finished to submit the bill.");
}

async function stepSubmit(from, session) {
  session.step = "SUBMITTING";
  await sendText(from, "Submitting your bill...");
  const now  = new Date();
  const date = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  try {
    const result = await apiPostWithPhoneFallback("bill-submit", {
      company_id:  session.company_id,
      date, on_time: time,
      project_id:  session.project_id,
      supplier_id: session.supplier_id,
      category_id: session.category_id,
      amount:      session.amount,
      remarks:     session.remarks || "",
      item:        JSON.stringify(session.files),
    }, session.rawPhone);
    if (result) {
      await sendText(from,
        `✅ Bill Submitted Successfully!\n\n` +
        `Company:  ${session.company_label}\nProject:  ${session.project_label}\n` +
        `Category: ${session.category_label}\nVendor:   ${session.supplier_label}\n` +
        `Amount:   Rs.${Number(session.amount || 0).toLocaleString("en-IN")}\n` +
        `Remarks:  ${session.remarks || "-"}\n` +
        `Files:    ${session.files.length > 0 ? session.files.length + " attached" : "None"}\n\n` +
        `Send hi to submit another bill.`
      );
    } else {
      await sendText(from, "❌ Bill submission failed. Please try again.\nSend hi to restart.");
    }
  } catch (err) {
    await sendText(from, "❌ Bill submission failed. Please try again.\nSend hi to restart.");
  }
  clearSession(from);
}

async function handleMessage(from, message, contactName) {
  const session = getSession(from, contactName);

  if (["image", "document", "video", "audio"].includes(message.type)) {
    if (session.step === "PHOTO") {
      const mediaId = (message.image?.id) || (message.document?.id) || (message.video?.id);
      if (mediaId) {
        await sendText(from, "Processing file...");
        const base64 = await downloadMedia(mediaId);
        if (base64) { session.files.push({ id: Date.now(), document: base64 }); await sendText(from, `File ${session.files.length} received! Send more or type done to submit.`); }
        else await sendText(from, "Could not process that file. Try again or type done to submit.");
      }
      return;
    }
    await sendText(from, "Please follow the current step. Type cancel to restart."); return;
  }

  if (message.type === "interactive") {
    const interactive = message.interactive;
    let selectedId = "";
    if (interactive.type === "button_reply")    selectedId = interactive.button_reply.id;
    else if (interactive.type === "list_reply") selectedId = interactive.list_reply.id;

    // ✅ Submit Another Bill — open flow directly without greeting
    if (selectedId === "submit_another_bill") {
      clearSession(from);
      const newSession = getSession(from, contactName);
      newSession.step  = "FLOW_SENT";
      await sendFlowDirect(from, phone91(from), from);
      return;
    }
    if (session.step === "WELCOME" && selectedId === "create_bill") { await stepCompany(from, session); return; }
    if (session.step === "COMPANY") {
      const picked = session.companies.find((c) => String(c.value || c.id) === selectedId);
      if (picked) { session.company_id = picked.value || picked.id; session.company_label = picked.label || picked.name; await stepCategory(from, session); }
      return;
    }
    if (session.step === "CATEGORY") {
      const picked = session.categories.find((c) => String(c.value || c.id) === selectedId);
      if (picked) { session.category_id = picked.value || picked.id; session.category_label = picked.label || picked.name; await stepProject(from, session); }
      return;
    }
    if (session.step === "PROJECT") {
      const picked = session.projects.find((p) => String(p.value || p.id) === selectedId);
      if (picked) { session.project_id = picked.value || picked.id; session.project_label = picked.label || picked.name; await stepAmount(from, session); }
      return;
    }
    if (session.step === "VENDOR") {
      const picked = session.vendors.find((v) => String(v.value || v.id) === selectedId);
      if (picked) { session.supplier_id = picked.value || picked.id; session.supplier_label = picked.label || picked.name; await stepRemarks(from, session); }
      return;
    }
    return;
  }

  const text  = String((message.text && message.text.body) || "").trim();
  const lower = text.toLowerCase();

  if (lower === "cancel") { clearSession(from); await sendText(from, "Session cancelled. Send hi to start again."); return; }

  switch (session.step) {
    case "START":
      if (["hi", "hello", "hey", "hii", "hai", "helo"].includes(lower)) await stepWelcome(from, session);
      else await sendText(from, "Send hi to get started with ProfitDesk.");
      break;
    case "WELCOME":
      if (["hi", "hello", "hey"].includes(lower)) await sendButtons(from, `Hi ${session.name || "there"}, Welcome to ProfitDesk!\n\nClick below to create a new bill.`, [{ id: "create_bill", title: "Create Bill" }]);
      break;
    case "FLOW_SENT":
      if (["hi", "hello"].includes(lower)) await sendText(from, "Please complete the bill form that was sent to you.");
      else await sendText(from, "Please fill the bill form above. Type cancel to restart.");
      break;
    case "AMOUNT": {
      const amount = parseFloat(text.replace(/,/g, ""));
      if (isNaN(amount) || amount <= 0) await sendText(from, "Please enter a valid amount (numbers only).\nExample: 5000");
      else { session.amount = amount; await stepVendor(from, session); }
      break;
    }
    case "REMARKS":
      session.remarks = lower === "skip" ? "" : text;
      await stepPhoto(from, session);
      break;
    case "PHOTO":
      if (lower === "done") await stepSubmit(from, session);
      else await sendText(from, "Send a file or type done to submit the bill.");
      break;
    default:
      if (["hi", "hello"].includes(lower)) { clearSession(from); await stepWelcome(from, getSession(from, contactName)); }
      else await sendText(from, "Send hi to get started.");
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WHATSAPP FLOW WEBHOOK
// ═════════════════════════════════════════════════════════════════════════════

router.post("/flow", async (req, res) => {
  console.log(`\n📋 Flow webhook hit | keys=${Object.keys(req.body).join(",")}`);
  try {
    let decryptedBody, aesKey, iv;
    try {
      const result = decryptFlowRequest(req.body);
      decryptedBody = result.decryptedBody; aesKey = result.aesKey; iv = result.iv;
    } catch (decErr) {
      console.error("[Flow] Decrypt error:", decErr.message);
      return res.status(421).send("Decryption failed");
    }

    const { screen, data = {}, flow_token, action } = decryptedBody;
    const rawPhone = flow_token || "";
    console.log(`📋 screen=${screen || "INIT"} | action=${action} | flow_token=${rawPhone}`);

    const reply = (responseObj) => {
      const encrypted = encryptFlowResponse(responseObj, aesKey, iv);
      return res.status(200).send(encrypted);
    };

    if (action === "ping") return reply({ data: { status: "active" } });

    // ── INIT ─────────────────────────────────────────────────────────────────
    if (action === "INIT" || !screen || screen === "INIT" || screen === "WELCOME") {
      const companyRes = await apiPostWithPhoneFallback("user-company-list", {}, rawPhone);
      if (!companyRes || companyRes.length === 0) {
        return reply({ screen: "BILL_FORM", data: { categories: [{ id: "err", title: "Not registered" }], projects: [{ id: "err", title: "Not registered" }], vendors: [{ id: "0", title: "None" }], error_message: "Your account is not active. Contact admin.", init_remarks: "" } });
      }
      const company   = companyRes[0];
      const companyId = Number(company.value ?? company.id);
      const [categoryRes, projectRes, vendorRes] = await Promise.all([
        apiPostWithPhoneFallback("category-list",     {},                                         rawPhone),
        apiPostWithPhoneFallback("user-project-list", { company_id: companyId },                  rawPhone),
        apiPostWithPhoneFallback("vendor-list",       { company_id: companyId, category_id: 1 }, rawPhone),
      ]);
      const categories  = Array.isArray(categoryRes) ? categoryRes.map(toDropdownItem) : [];
      const projects    = Array.isArray(projectRes)  ? projectRes.map(toDropdownItem)  : [];
      const vendorItems = Array.isArray(vendorRes) ? vendorRes.filter((v) => String(v.value ?? v.id) !== "0").map(toDropdownItem) : [];
      const vendors     = [{ id: "0", title: "None" }, ...vendorItems];
      if (categories.length === 0) categories.push({ id: "err", title: "No categories found" });
      if (projects.length   === 0) projects.push(  { id: "err", title: "No projects found"   });
      return reply({ screen: "BILL_FORM", data: { categories, projects, vendors, error_message: "", init_remarks: "" } });
    }

    // ── BILL_FORM → ADD_PHOTOS ────────────────────────────────────────────────
    if (screen === "BILL_FORM") {
      const { category, project, amount, vendor, remarks } = data;
      if (!category || !project || !amount) return reply({ screen: "BILL_FORM", data: { error_message: "Category, Project and Amount are required." } });
      if (isNaN(Number(amount)) || Number(amount) <= 0) return reply({ screen: "BILL_FORM", data: { error_message: "Please enter a valid amount." } });

      const companyRes = await apiPostWithPhoneFallback("user-company-list", {}, rawPhone);
      const companyId  = companyRes?.[0] ? Number(companyRes[0].value ?? companyRes[0].id) : 0;
      const [catList, projList, vendList] = await Promise.all([
        apiPostWithPhoneFallback("category-list",     {},                                         rawPhone),
        apiPostWithPhoneFallback("user-project-list", { company_id: companyId },                  rawPhone),
        apiPostWithPhoneFallback("vendor-list",       { company_id: companyId, category_id: 1 }, rawPhone),
      ]);

      const catName  = findName(catList,  category);
      const projName = findName(projList, project);
      const vendName = (!vendor || vendor === "0") ? "None" : findName(vendList, vendor);

      return reply({
        screen: "ADD_PHOTOS",
        data: {
          error_message: "",
          category, category_name: catName,
          project,  project_name:  projName,
          vendor:   vendor || "0", vendor_name: vendName,
          amount:   String(amount),
          remarks:  remarks || "",
        },
      });
    }

    // ── ADD_PHOTOS → ADD_DOCUMENTS ────────────────────────────────────────────
    if (screen === "ADD_PHOTOS") {
      const { category, category_name, project, project_name, vendor, vendor_name, amount, remarks, photos } = data;
      return reply({
        screen: "ADD_DOCUMENTS",
        data: {
          error_message: "",
          category, category_name: category_name || category,
          project,  project_name:  project_name  || project,
          vendor:   vendor || "0", vendor_name: vendor_name || "None",
          amount:   amount  || "",
          remarks:  remarks || "",
          photos:   Array.isArray(photos) ? photos : [],
        },
      });
    }

    // ── ADD_DOCUMENTS → REVIEW ────────────────────────────────────────────────
    if (screen === "ADD_DOCUMENTS") {
      const { category, category_name, project, project_name, vendor, vendor_name, amount, remarks, photos, documents } = data;

      // ✅ Always fetch fresh names from API (in case flow JSON didn't pass them)
      const companyResX = await apiPostWithPhoneFallback("user-company-list", {}, rawPhone);
      const companyIdX  = companyResX?.[0] ? Number(companyResX[0].value ?? companyResX[0].id) : 0;
      const [catListX, projListX, vendListX] = await Promise.all([
        apiPostWithPhoneFallback("category-list",     {},                                          rawPhone),
        apiPostWithPhoneFallback("user-project-list", { company_id: companyIdX },                  rawPhone),
        apiPostWithPhoneFallback("vendor-list",       { company_id: companyIdX, category_id: 1 }, rawPhone),
      ]);

      // Debug: log first item to see API response format
      console.log(`[ADD_DOCUMENTS] catList[0]=`, JSON.stringify(catListX?.[0]));
      console.log(`[ADD_DOCUMENTS] projList[0]=`, JSON.stringify(projListX?.[0]));
      console.log(`[ADD_DOCUMENTS] category id to match=`, category);

      const catNameX  = findName(catListX,  category);
      const projNameX = findName(projListX, project);
      const vendNameX = (!vendor || vendor === "0") ? "None" : findName(vendListX, vendor);

      console.log(`[ADD_DOCUMENTS] cat=${category} cat_name=${catNameX} proj=${project} proj_name=${projNameX} vendor=${vendor} vendor_name=${vendNameX}`);

      return reply({
        screen: "REVIEW",
        data: {
          error_message: "",
          category,      category_name: catNameX,
          project,       project_name:  projNameX,
          vendor:        vendor || "0", vendor_name: vendNameX,
          amount:        amount  || "",
          remarks:       remarks || "",
          photos:        Array.isArray(photos)    ? photos    : [],
          documents:     Array.isArray(documents) ? documents : [],
        },
      });
    }

    // ── REVIEW → Submit or Cancel ────────────────────────────────────────────
    if (screen === "REVIEW") {
      const { category, category_name, project, project_name, vendor, vendor_name, amount, remarks, photos, documents } = data;
      const now  = new Date();
      const date = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
      const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
      const allFiles = [...(Array.isArray(photos) ? photos : []), ...(Array.isArray(documents) ? documents : [])];

      const companyRes2 = await apiPostWithPhoneFallback("user-company-list", {}, rawPhone);
      const companyId2  = companyRes2?.[0] ? Number(companyRes2[0].value ?? companyRes2[0].id) : 0;

      console.log(`[Flow SUBMIT] company_id=${companyId2} category=${category} project=${project} amount=${amount} vendor=${vendor} files=${allFiles.length}`);

      const submitResult = await apiPostWithPhoneFallback("bill-submit", {
        company_id:  companyId2,
        date, on_time: time,
        category_id: category,
        project_id:  project,
        supplier_id: (!vendor || vendor === "0") ? 0 : Number(vendor),
        amount:      Number(amount),
        remarks:     remarks || "",
        item:        JSON.stringify(allFiles),
      }, rawPhone);

      console.log(`[Flow SUBMIT] result: ${JSON.stringify(submitResult)}`);

      if (!submitResult && submitResult !== true) {
        return reply({ screen: "REVIEW", data: { error_message: "Submission failed. Please try again." } });
      }

      const filesCount = allFiles.length;
      const catName    = category_name || category;
      const projName   = project_name  || project;
      const vendName   = vendor_name   || ((!vendor || vendor === "0") ? "None" : vendor);

      setImmediate(async () => {
        try {
          const Bill = require("../models/Bill");
          await Bill.create({
            source: "whatsapp_flow", category: catName,
            amount: Number(amount), vendor: vendName,
            remarks: remarks || "", status: "Not Started", attachments: [],
          });
        } catch (dbErr) { console.warn("[Flow] MongoDB save skipped:", dbErr.message); }
      });

      const userPhone = phone91(rawPhone);
      lastBillData.set(userPhone, { category, project, vendor: vendor || "0", amount: String(amount), remarks: remarks || "" });
      clearSession(userPhone);
      clearSession(rawPhone);

      console.log("[Flow] Sending success message");

      try {
        await axios.post(`${GRAPH_URL}/messages`, {
          messaging_product: "whatsapp",
          to: userPhone,
          type: "interactive",
          interactive: {
            type: "button",
            body: {
              text: `✅ Bill Submitted Successfully!\n\n` +
                    `Category: ${catName}\n` +
                    `Project:  ${projName}\n` +
                    `Vendor:   ${vendName}\n` +
                    `Amount:   Rs.${Number(amount).toLocaleString("en-IN")}\n` +
                    `Files:    ${filesCount} file(s)\n\n` +
                    `Tap below to submit another bill.`
            },
            action: {
              buttons: [
                { type: "reply", reply: { id: "submit_another_bill", title: "Submit Another Bill" } }
              ]
            }
          }
        }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
      } catch (msgErr) {
        console.warn("[Flow] WhatsApp message failed:", msgErr.message);
      }

      return reply({ screen: "SUCCESS", data: {} });
    // ── SUCCESS (terminal) ────────────────────────────────────────────────────
    if (screen === "SUCCESS") {
      return reply({ data: { status: "ok" } });
    }
    }

    console.warn(`[Flow] Unknown screen: ${screen}`);
    return res.status(400).send("Unknown screen");

  } catch (err) {
    console.error("[Flow] Unhandled error:", err?.response?.data || err.message);
    return res.status(500).send("Server error");
  }
});

router.get("/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
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
        const value = change.value;
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