const { Router } = require("express");
const axios = require("axios");

const router = Router();

const VERIFY_TOKEN     = process.env.WHATSAPP_VERIFY_TOKEN    || "profitdesk_verify_token";
const PHONE_NUMBER_ID  = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN     = process.env.WHATSAPP_ACCESS_TOKEN;
const CUSTOMER_API     = process.env.CUSTOMER_API_BASE_URL    || "https://prod.thinksoft.in/profitdesk/api/site-engineer";
const FLOW_ID          = process.env.FLOW_ID;
const GRAPH_URL        = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}`;
const SESSION_TTL_MS   = 30 * 60 * 1000;

// ─── TEST numbers (bypass external API) ──────────────────────────────────────
// Remove these numbers once real API is ready
const TEST_NUMBERS = ["7904307757", "7708420110"];

function isTestNumber(phone) {
  return TEST_NUMBERS.includes(phone);
}

// ─── Session management ───────────────────────────────────────────────────────

const sessions = new Map();

function getSession(from, name) {
  const now = Date.now();
  const existing = sessions.get(from);
  if (existing && now - existing.createdAt > SESSION_TTL_MS) {
    sessions.delete(from);
  }
  if (!sessions.has(from)) {
    sessions.set(from, {
      createdAt: now,
      step: "START",
      phone: from.replace(/\D/g, "").slice(-10),
      name: name || "",
      company_id: null,
      company_label: "",
      category_id: null,
      category_label: "",
      project_id: null,
      project_label: "",
      supplier_id: 0,
      supplier_label: "",
      amount: null,
      remarks: "",
      files: [],
      companies: [],
      categories: [],
      projects: [],
      vendors: [],
    });
  }
  const session = sessions.get(from);
  if (name && !session.name) session.name = name;
  return session;
}

function clearSession(from) {
  sessions.delete(from);
}

// ─── External API ─────────────────────────────────────────────────────────────

async function apiPost(endpoint, body) {
  try {
    const res = await axios.post(`${CUSTOMER_API}/${endpoint}`, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });
    if (res.data && res.data.status === "Success") return res.data.data;
    return null;
  } catch (err) {
    console.error(`[apiPost] ${endpoint} error:`, err.message);
    return null;
  }
}

// ─── WhatsApp senders ─────────────────────────────────────────────────────────

async function sendText(to, text) {
  await axios.post(
    `${GRAPH_URL}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

async function sendButtons(to, body, buttons) {
  await axios.post(
    `${GRAPH_URL}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

async function sendList(to, bodyText, buttonLabel, items) {
  await axios.post(
    `${GRAPH_URL}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonLabel,
          sections: [
            {
              title: "Options",
              rows: items.slice(0, 10).map((item) => ({
                id: String(item.value),
                title: String(item.label).slice(0, 24),
              })),
            },
          ],
        },
      },
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

async function sendMenu(to, bodyText, label, items) {
  if (items.length <= 3) {
    await sendButtons(
      to,
      bodyText,
      items.map((i) => ({ id: String(i.value), title: String(i.label) }))
    );
  } else {
    await sendList(to, bodyText, label, items);
  }
}

// ─── Send WhatsApp Flow message ───────────────────────────────────────────────

async function sendFlowMessage(to, phone) {
  await axios.post(
    `${GRAPH_URL}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "flow",
        body: { text: "Create a new bill using the form below." },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_token: phone,
            flow_id: FLOW_ID,
            flow_cta: "Open Bill Form",
            flow_action: "navigate",
            flow_action_payload: {
              screen: "BILL_FORM",
            },
          },
        },
      },
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

async function downloadMedia(mediaId) {
  try {
    const urlRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const mediaUrl = urlRes.data && urlRes.data.url;
    if (!mediaUrl) return null;
    const fileRes = await axios.get(mediaUrl, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      responseType: "arraybuffer",
    });
    const mimeType = fileRes.headers["content-type"] || "image/jpeg";
    const base64 = Buffer.from(fileRes.data).toString("base64");
    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    return null;
  }
}

// ─── Chat Flow steps ──────────────────────────────────────────────────────────

async function stepWelcome(from, session) {
  // ── TEST MODE: bypass external API for test numbers ───────────────────────
  let companies;
  if (isTestNumber(session.phone)) {
    console.log(`[TEST MODE] Bypassing API for ${session.phone}`);
    companies = [{ value: "1", label: "Test Company" }];
  } else {
    companies = await apiPost("user-company-list", { phone: session.phone });
  }

  if (!companies || companies.length === 0) {
    await sendText(from, "Your number is not registered in ProfitDesk. Please contact your admin.");
    clearSession(from);
    return;
  }
  session.companies = companies;
  session.step = "WELCOME";
  const name = session.name || "there";

  if (FLOW_ID) {
    await sendText(from, `Hi ${name}, Welcome to ProfitDesk!\n\nUse the form below to submit a new bill.`);
    await sendFlowMessage(from, session.phone);
    session.step = "FLOW_SENT";
    return;
  }

  await sendButtons(
    from,
    `Hi ${name}, Welcome to ProfitDesk!\n\nClick below to create a new bill.`,
    [{ id: "create_bill", title: "Create Bill" }]
  );
}

async function stepCompany(from, session) {
  if (session.companies.length === 1) {
    session.company_id    = session.companies[0].value;
    session.company_label = session.companies[0].label;
    await stepCategory(from, session);
    return;
  }
  session.step = "COMPANY";
  await sendMenu(from, "Select your company:", "Select Company", session.companies);
}

async function stepCategory(from, session) {
  let categories;
  if (isTestNumber(session.phone)) {
    categories = [
      { value: "1", label: "Material" },
      { value: "2", label: "Manpower" },
      { value: "3", label: "Equipment" },
      { value: "4", label: "Others" },
    ];
  } else {
    categories = await apiPost("category-list", { phone: session.phone });
  }

  if (!categories || categories.length === 0) {
    await sendText(from, "No categories found. Please contact admin.");
    clearSession(from);
    return;
  }
  session.categories = categories;
  session.step = "CATEGORY";
  await sendMenu(from, "Select bill category:", "Select Category", categories);
}

async function stepProject(from, session) {
  let projects;
  if (isTestNumber(session.phone)) {
    projects = [
      { value: "1", label: "Site A" },
      { value: "2", label: "Site B" },
    ];
  } else {
    projects = await apiPost("user-project-list", { phone: session.phone });
  }

  if (!projects || projects.length === 0) {
    await sendText(from, "No projects found. Please contact admin.");
    clearSession(from);
    return;
  }
  session.projects = projects;
  session.step = "PROJECT";
  await sendMenu(from, "Select your project:", "Select Project", projects);
}

async function stepAmount(from, session) {
  session.step = "AMOUNT";
  await sendText(
    from,
    `Category: ${session.category_label}\nProject: ${session.project_label}\n\nEnter the bill amount (numbers only):\nExample: 5000`
  );
}

async function stepVendor(from, session) {
  let vendors;
  if (isTestNumber(session.phone)) {
    vendors = [
      { value: "1", label: "ABC Traders" },
      { value: "2", label: "XYZ Suppliers" },
    ];
  } else {
    vendors = await apiPost("vendor-list", {
      phone: session.phone,
      company_id: session.company_id,
      category_id: session.category_id,
    });
  }

  if (!vendors || vendors.length === 0) {
    session.supplier_id    = 0;
    session.supplier_label = "-";
    await stepRemarks(from, session);
    return;
  }
  session.vendors = vendors;
  session.step = "VENDOR";
  await sendMenu(from, "Select vendor / supplier:", "Select Vendor", vendors);
}

async function stepRemarks(from, session) {
  session.step = "REMARKS";
  await sendText(from, "Enter remarks (or type skip to continue without remarks):");
}

async function stepPhoto(from, session) {
  session.step = "PHOTO";
  await sendText(
    from,
    "Send bill photos, PDFs, or documents (optional).\n\nSend multiple files one by one.\nType done when finished to submit the bill."
  );
}

async function stepSubmit(from, session) {
  session.step = "SUBMITTING";
  await sendText(from, "Submitting your bill...");

  const now  = new Date();
  const date = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

  try {
    // ── TEST MODE: skip real API submit ───────────────────────────────────
    let result;
    if (isTestNumber(session.phone)) {
      console.log(`[TEST MODE] Skipping bill-submit API for ${session.phone}`);
      result = { ref_bill_no: `TEST/06/2026-00001` };
    } else {
      result = await apiPost("bill-submit", {
        phone:       session.phone,
        company_id:  session.company_id,
        date,
        on_time:     time,
        project_id:  session.project_id,
        supplier_id: session.supplier_id,
        category_id: session.category_id,
        amount:      session.amount,
        remarks:     session.remarks || "",
        item:        JSON.stringify(session.files),
      });
    }

    if (result) {
      await sendText(
        from,
        `✅ Bill Submitted Successfully!\n\n` +
          `Company:  ${session.company_label}\n` +
          `Project:  ${session.project_label}\n` +
          `Category: ${session.category_label}\n` +
          `Vendor:   ${session.supplier_label}\n` +
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

// ─── Main chat message handler ────────────────────────────────────────────────

async function handleMessage(from, message, contactName) {
  const session = getSession(from, contactName);

  if (["image", "document", "video", "audio"].includes(message.type)) {
    if (session.step === "PHOTO") {
      const img     = message.image;
      const doc     = message.document;
      const vid     = message.video;
      const mediaId = (img && img.id) || (doc && doc.id) || (vid && vid.id);
      if (mediaId) {
        await sendText(from, "Processing file...");
        const base64 = await downloadMedia(mediaId);
        if (base64) {
          session.files.push({ id: Date.now(), document: base64 });
          await sendText(from, `File ${session.files.length} received! Send more or type done to submit.`);
        } else {
          await sendText(from, "Could not process that file. Try again or type done to submit.");
        }
      }
      return;
    }
    await sendText(from, "Please follow the current step. Type cancel to restart.");
    return;
  }

  if (message.type === "interactive") {
    const interactive = message.interactive;
    let selectedId = "";

    if (interactive.type === "button_reply") {
      selectedId = interactive.button_reply.id;
    } else if (interactive.type === "list_reply") {
      selectedId = interactive.list_reply.id;
    }

    if (session.step === "WELCOME" && selectedId === "create_bill") {
      await stepCompany(from, session);
      return;
    }
    if (session.step === "COMPANY") {
      const picked = session.companies.find((c) => String(c.value) === selectedId);
      if (picked) {
        session.company_id    = picked.value;
        session.company_label = picked.label;
        await stepCategory(from, session);
      }
      return;
    }
    if (session.step === "CATEGORY") {
      const picked = session.categories.find((c) => String(c.value) === selectedId);
      if (picked) {
        session.category_id    = picked.value;
        session.category_label = picked.label;
        await stepProject(from, session);
      }
      return;
    }
    if (session.step === "PROJECT") {
      const picked = session.projects.find((p) => String(p.value) === selectedId);
      if (picked) {
        session.project_id    = picked.value;
        session.project_label = picked.label;
        await stepAmount(from, session);
      }
      return;
    }
    if (session.step === "VENDOR") {
      const picked = session.vendors.find((v) => String(v.value) === selectedId);
      if (picked) {
        session.supplier_id    = picked.value;
        session.supplier_label = picked.label;
        await stepRemarks(from, session);
      }
      return;
    }
    return;
  }

  const text  = String((message.text && message.text.body) || "").trim();
  const lower = text.toLowerCase();

  if (lower === "cancel") {
    clearSession(from);
    await sendText(from, "Session cancelled. Send hi to start again.");
    return;
  }

  switch (session.step) {
    case "START": {
      if (["hi", "hello", "hey", "hii", "hai", "helo"].includes(lower)) {
        await stepWelcome(from, session);
      } else {
        await sendText(from, "Send hi to get started with ProfitDesk.");
      }
      break;
    }

    case "WELCOME": {
      if (["hi", "hello", "hey"].includes(lower)) {
        const name = session.name || "there";
        await sendButtons(
          from,
          `Hi ${name}, Welcome to ProfitDesk!\n\nClick below to create a new bill.`,
          [{ id: "create_bill", title: "Create Bill" }]
        );
      }
      break;
    }

    case "FLOW_SENT": {
      if (["hi", "hello"].includes(lower)) {
        await sendText(from, "Please complete the bill form that was sent to you.");
      } else {
        await sendText(from, "Please fill the bill form above. Type cancel to restart.");
      }
      break;
    }

    case "AMOUNT": {
      const amount = parseFloat(text.replace(/,/g, ""));
      if (isNaN(amount) || amount <= 0) {
        await sendText(from, "Please enter a valid amount (numbers only).\nExample: 5000");
      } else {
        session.amount = amount;
        await stepVendor(from, session);
      }
      break;
    }

    case "REMARKS": {
      session.remarks = lower === "skip" ? "" : text;
      await stepPhoto(from, session);
      break;
    }

    case "PHOTO": {
      if (lower === "done") {
        await stepSubmit(from, session);
      } else {
        await sendText(from, "Send a file or type done to submit the bill.");
      }
      break;
    }

    default: {
      if (["hi", "hello"].includes(lower)) {
        clearSession(from);
        await stepWelcome(from, getSession(from, contactName));
      } else {
        await sendText(from, "Send hi to get started.");
      }
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ⭐ WHATSAPP FLOW WEBHOOK — POST /webhook/flow
// ═════════════════════════════════════════════════════════════════════════════

router.post("/flow", async (req, res) => {
  const { screen, data = {}, flow_token } = req.body;
  const phone = flow_token;

  console.log(`\n📋 Flow webhook | screen=${screen || "INIT"} | phone=${phone}`);

  try {

    // ── INIT: Flow opened → load dropdowns ─────────────────────────────────
    if (!screen || screen === "INIT") {

      // TEST MODE: skip company check for test numbers
      if (!isTestNumber(phone)) {
        const companyCheck = await apiPost("user-company-enable", { phone });
        if (!companyCheck) {
          return res.json({
            screen: "BILL_FORM",
            data: {
              categories:    [{ id: "err", title: "No company found" }],
              projects:      [{ id: "err", title: "No project found" }],
              vendors:       [{ id: "0",   title: "None" }],
              error_message: "Your account is not active. Contact admin.",
            },
          });
        }
      }

      let categories, projects, vendors;

      if (isTestNumber(phone)) {
        // ── TEST DATA ───────────────────────────────────────────────────────
        console.log(`[TEST MODE] Returning mock dropdown data for ${phone}`);
        categories = [
          { id: "1", title: "Material" },
          { id: "2", title: "Manpower" },
          { id: "3", title: "Equipment" },
          { id: "4", title: "Others" },
        ];
        projects = [
          { id: "1", title: "Site A" },
          { id: "2", title: "Site B" },
        ];
        vendors = [
          { id: "0",  title: "None" },
          { id: "1",  title: "ABC Traders" },
          { id: "2",  title: "XYZ Suppliers" },
        ];
      } else {
        // ── REAL API ────────────────────────────────────────────────────────
        const [categoryRes, projectRes, vendorRes] = await Promise.all([
          apiPost("category-list",     { phone }),
          apiPost("user-project-list", { phone }),
          apiPost("user-company-list", { phone }),
        ]);

        categories = (categoryRes || []).map((c) => ({
          id:    String(c.id    || c.value || c.category_id),
          title: String(c.name  || c.label || c.category_name || c.title),
        }));

        projects = (projectRes || []).map((p) => ({
          id:    String(p.id    || p.value || p.project_id),
          title: String(p.name  || p.label || p.project_name || p.title),
        }));

        vendors = [
          { id: "0", title: "None" },
          ...(vendorRes || []).map((v) => ({
            id:    String(v.id    || v.value || v.company_id),
            title: String(v.name  || v.label || v.company_name || v.title),
          })),
        ];
      }

      return res.json({
        screen: "BILL_FORM",
        data: { categories, projects, vendors, error_message: "" },
      });
    }

    // ── BILL_FORM → ADD_PHOTOS ───────────────────────────────────────────────
    if (screen === "BILL_FORM") {
      const { category, project, amount, vendor, remarks } = data;

      if (!category || !project || !amount) {
        return res.json({
          screen: "BILL_FORM",
          data: { error_message: "Category, Project and Amount are required." },
        });
      }
      if (isNaN(Number(amount)) || Number(amount) <= 0) {
        return res.json({
          screen: "BILL_FORM",
          data: { error_message: "Please enter a valid amount." },
        });
      }

      return res.json({
        screen: "ADD_PHOTOS",
        data: {
          error_message: "",
          category:      category,
          project:       project,
          vendor:        vendor || "0",
          amount:        String(amount),
          remarks:       remarks || "",
        },
      });
    }

    // ── ADD_PHOTOS → ADD_DOCUMENTS ───────────────────────────────────────────
    if (screen === "ADD_PHOTOS") {
      const { category, project, vendor, amount, remarks, photos } = data;

      return res.json({
        screen: "ADD_DOCUMENTS",
        data: {
          error_message: "",
          category:      category || "",
          project:       project  || "",
          vendor:        vendor   || "0",
          amount:        amount   || "",
          remarks:       remarks  || "",
          photos:        Array.isArray(photos) ? photos : [],
        },
      });
    }

    // ── ADD_DOCUMENTS → Submit ───────────────────────────────────────────────
    if (screen === "ADD_DOCUMENTS") {
      const { category, project, vendor, amount, remarks, photos, documents } = data;

      const now  = new Date();
      const date = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
      const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

      let submitResult;

      if (isTestNumber(phone)) {
        // ── TEST MODE: mock submit ──────────────────────────────────────────
        console.log(`[TEST MODE] Mock bill submit for ${phone}`);
        submitResult = {
          ref_bill_no: `TEST/06/2026-00001`,
          category_id: category,
          project_id:  project,
          supplier_id: vendor || "0",
        };
      } else {
        // ── REAL API submit ─────────────────────────────────────────────────
        submitResult = await apiPost("bill-submit", {
          phone,
          date,
          on_time:     time,
          category_id: category,
          project_id:  project,
          supplier_id: (!vendor || vendor === "0") ? 0 : vendor,
          amount:      Number(amount),
          remarks:     remarks || "",
          item:        JSON.stringify([
            ...(Array.isArray(photos)    ? photos    : []),
            ...(Array.isArray(documents) ? documents : []),
          ]),
        });
      }

      if (!submitResult) {
        return res.json({
          screen: "ADD_DOCUMENTS",
          data: { error_message: "Submission failed. Please try again." },
        });
      }

      const bill       = submitResult;
      const filesCount = (photos?.length || 0) + (documents?.length || 0);

      // ── Save to MongoDB (non-fatal) ───────────────────────────────────────
      try {
        const Bill = require("../models/Bill");
        await Bill.create({
          source:   "whatsapp_flow",
          company:  bill.company_id  || null,
          project:  bill.project_id  || null,
          category: bill.category_id || category,
          amount:   Number(amount),
          vendor:   (!vendor || vendor === "0") ? "None" : String(bill.supplier_id || vendor),
          remarks:  remarks || "",
          status:   "Not Started",
          billId:   bill.ref_bill_no || bill.bill_no || null,
          attachments: [],
        });
      } catch (dbErr) {
        console.warn("[Flow] MongoDB Bill save skipped:", dbErr.message);
      }

      return res.json({
        screen: "SUCCESS",
        data: {
          ref_bill_no: bill.ref_bill_no || bill.bill_no || "—",
          category:    bill.category_id  || category,
          project:     bill.project_id   || project,
          amount:      Number(amount).toLocaleString("en-IN"),
          vendor:      (!vendor || vendor === "0") ? "None" : String(bill.supplier_id || vendor),
          files_count: `${filesCount} file(s)`,
        },
      });
    }

    return res.status(400).json({ error: `Unknown screen: ${screen}` });

  } catch (err) {
    console.error("[Flow] Error:", err?.response?.data || err.message);
    return res.status(500).json({
      screen: screen || "BILL_FORM",
      data: { error_message: "Server error. Please try again later." },
    });
  }
});

// ─── Webhook verification ─────────────────────────────────────────────────────

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

// ─── Receive WhatsApp messages ────────────────────────────────────────────────

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

        const contacts    = value.contacts;
        const contactName = contacts?.[0]?.profile?.name || "";

        for (const message of messages) {
          const from = message.from;
          try {
            await handleMessage(from, message, contactName);
          } catch (err) {
            console.error("WhatsApp handler error:", err);
          }
        }
      }
    }
  })().catch(console.error);
});

module.exports = router;