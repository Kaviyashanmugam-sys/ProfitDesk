const { Router } = require("express");
const axios = require("axios");

const router = Router();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "profitdesk_verify_token";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const CUSTOMER_API = process.env.CUSTOMER_API_BASE_URL || "https://prod.thinksoft.in/profitdesk/api/site-engineer";
const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}`;
const SESSION_TTL_MS = 30 * 60 * 1000;

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

// ─── Flow steps ───────────────────────────────────────────────────────────────

async function stepWelcome(from, session) {
  const companies = await apiPost("user-company-list", { phone: session.phone });
  if (!companies || companies.length === 0) {
    await sendText(from, "Your number is not registered in ProfitDesk. Please contact your admin.");
    clearSession(from);
    return;
  }
  session.companies = companies;
  session.step = "WELCOME";
  const name = session.name || "there";
  await sendButtons(
    from,
    `Hi ${name}, Welcome to ProfitDesk!\n\nClick below to create a new bill.`,
    [{ id: "create_bill", title: "Create Bill" }]
  );
}

async function stepCompany(from, session) {
  if (session.companies.length === 1) {
    session.company_id = session.companies[0].value;
    session.company_label = session.companies[0].label;
    await stepCategory(from, session);
    return;
  }
  session.step = "COMPANY";
  await sendMenu(from, "Select your company:", "Select Company", session.companies);
}

async function stepCategory(from, session) {
  const categories = await apiPost("category-list", { phone: session.phone });
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
  const projects = await apiPost("user-project-list", { phone: session.phone });
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
  const vendors = await apiPost("vendor-list", {
    phone: session.phone,
    company_id: session.company_id,
    category_id: session.category_id,
  });
  if (!vendors || vendors.length === 0) {
    session.supplier_id = 0;
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

  const now = new Date();
  const date = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

  try {
    const result = await apiPost("bill-submit", {
      phone: session.phone,
      company_id: session.company_id,
      date,
      on_time: time,
      project_id: session.project_id,
      supplier_id: session.supplier_id,
      category_id: session.category_id,
      remarks: session.remarks || "",
      item: JSON.stringify(session.files),
    });

    if (result) {
      await sendText(
        from,
        `Bill Submitted Successfully!\n\n` +
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
      await sendText(from, "Bill submission failed. Please try again.\nSend hi to restart.");
    }
  } catch (err) {
    await sendText(from, "Bill submission failed. Please try again.\nSend hi to restart.");
  }

  clearSession(from);
}

// ─── Main message handler ─────────────────────────────────────────────────────

async function handleMessage(from, message, contactName) {
  const session = getSession(from, contactName);

  // Media files
  if (["image", "document", "video", "audio"].includes(message.type)) {
    if (session.step === "PHOTO") {
      const img = message.image;
      const doc = message.document;
      const vid = message.video;
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

  // Interactive replies (button / list)
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
        session.company_id = picked.value;
        session.company_label = picked.label;
        await stepCategory(from, session);
      }
      return;
    }

    if (session.step === "CATEGORY") {
      const picked = session.categories.find((c) => String(c.value) === selectedId);
      if (picked) {
        session.category_id = picked.value;
        session.category_label = picked.label;
        await stepProject(from, session);
      }
      return;
    }

    if (session.step === "PROJECT") {
      const picked = session.projects.find((p) => String(p.value) === selectedId);
      if (picked) {
        session.project_id = picked.value;
        session.project_label = picked.label;
        await stepAmount(from, session);
      }
      return;
    }

    if (session.step === "VENDOR") {
      const picked = session.vendors.find((v) => String(v.value) === selectedId);
      if (picked) {
        session.supplier_id = picked.value;
        session.supplier_label = picked.label;
        await stepRemarks(from, session);
      }
      return;
    }

    return;
  }

  // Text messages
  const text = String((message.text && message.text.body) || "").trim();
  const lower = text.toLowerCase();

  // Global cancel
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

// ─── Webhook routes ───────────────────────────────────────────────────────────

// GET: WhatsApp webhook verification
router.get("/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).send("Forbidden");
  }
});

// POST: Receive WhatsApp messages
router.post("/whatsapp", (req, res) => {
  res.sendStatus(200); // Respond immediately

  const body = req.body;
  if (body.object !== "whatsapp_business_account") return;

  (async () => {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value;
        const messages = value.messages;
        if (!messages || messages.length === 0) continue;

        const contacts = value.contacts;
        const contactName = contacts && contacts[0] && contacts[0].profile && contacts[0].profile.name;

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
