const { Router } = require("express");
const axios = require("axios");
const crypto = require("crypto");

const router = Router();

const VERIFY_TOKEN    = process.env.WHATSAPP_VERIFY_TOKEN    || "profitdesk_verify_token";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;
const CUSTOMER_API    = process.env.CUSTOMER_API_BASE_URL    || "https://prod.thinksoft.in/profitdesk/api/site-engineer";
const GRAPH_URL       = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}`;
const SESSION_TTL_MS  = 30 * 60 * 1000;

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
  if (result) {
    console.log(`[apiPost] ${endpoint} matched with phone10: ${p10}`);
    return result;
  }
  result = await apiPost(endpoint, { ...baseBody, phone: p91 });
  if (result) {
    console.log(`[apiPost] ${endpoint} matched with phone91: ${p91}`);
    return result;
  }
  console.warn(`[apiPost] ${endpoint} failed for both ${p10} and ${p91}`);
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// EXTERNAL API
// ═════════════════════════════════════════════════════════════════════════════

async function apiPost(endpoint, body) {
  try {
    const res = await axios.post(`${CUSTOMER_API}/${endpoint}`, body, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000,
    });
    if (res.data && String(res.data.status).toLowerCase() === "success") {
      return res.data.data;
    }
    console.warn(`[apiPost] ${endpoint} → status: ${res.data?.status} | msg: ${res.data?.message || "-"}`);
    return null;
  } catch (err) {
    console.error(`[apiPost] ${endpoint} error:`, err.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

const sessions = new Map();

function getSession(from, name) {
  const now      = Date.now();
  const existing = sessions.get(from);
  if (existing && now - existing.createdAt > SESSION_TTL_MS) {
    sessions.delete(from);
  }
  if (!sessions.has(from)) {
    sessions.set(from, {
      createdAt:      now,
      step:           "START",
      phone:          phone10(from),
      rawPhone:       from,
      name:           name || "",
      company_id:     null,
      company_label:  "",
      category_id:    null,
      category_label: "",
      project_id:     null,
      project_label:  "",
      supplier_id:    0,
      supplier_label: "",
      amount:         null,
      remarks:        "",
      files:          [],
      companies:      [],
      categories:     [],
      projects:       [],
      vendors:        [],
    });
  }
  const session = sessions.get(from);
  if (name && !session.name) session.name = name;
  return session;
}

function clearSession(from) {
  sessions.delete(from);
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
  } catch (err) {
    console.error(`[sendText] error:`, err.response?.data || err.message);
  }
}

async function sendButtons(to, body, buttons) {
  try {
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
              type:  "reply",
              reply: { id: String(b.id), title: String(b.title).slice(0, 20) },
            })),
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
  } catch (err) {
    console.error(`[sendButtons] error:`, err.response?.data || err.message);
  }
}

async function sendList(to, bodyText, buttonLabel, items) {
  try {
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
                  id:    String(item.id || item.value),
                  title: String(item.title || item.label || item.name).slice(0, 24),
                })),
              },
            ],
          },
        },
      },
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );
  } catch (err) {
    console.error(`[sendList] error:`, err.response?.data || err.message);
  }
}

// Smart menu — ≤3 items use buttons, >3 use list
async function sendMenu(to, bodyText, label, items) {
  const mapped = items.map((i) => ({
    id:    String(i.id    != null ? i.id    : i.value),
    title: String(i.title || i.label || i.name || "Unknown"),
  }));
  if (mapped.length === 0) {
    await sendText(to, `${bodyText}\n\n(No options available)`);
    return;
  }
  if (mapped.length <= 3) {
    await sendButtons(to, bodyText, mapped);
  } else {
    await sendList(to, bodyText, label, mapped);
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
    const base64   = Buffer.from(fileRes.data).toString("base64");
    return `data:${mimeType};base64,${base64}`;
  } catch (err) {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// CHAT FLOW STEPS
// ═════════════════════════════════════════════════════════════════════════════

async function stepWelcome(from, session) {
  // Check if registered
  const companies = await apiPostWithPhoneFallback("user-company-list", {}, session.rawPhone);
  if (!companies || companies.length === 0) {
    await sendText(from, "❌ Your number is not registered in ProfitDesk.\nPlease contact your admin.");
    clearSession(from);
    return;
  }
  session.companies = companies;

  // Auto-pick company if only one
  if (companies.length === 1) {
    session.company_id    = String(companies[0].id    != null ? companies[0].id    : companies[0].value);
    session.company_label = String(companies[0].title || companies[0].label || companies[0].name || "");
  }

  const name = session.name || "there";
  session.step = "WELCOME";

  await sendButtons(
    from,
    `Hi ${name}! 👋 Welcome to *ProfitDesk*.\n\nTap below to create a new bill.`,
    [{ id: "create_bill", title: "Create Bill" }]
  );
}

async function stepCategory(from, session) {
  const categories = await apiPostWithPhoneFallback("category-list", {}, session.rawPhone);
  if (!categories || categories.length === 0) {
    await sendText(from, "❌ No categories found. Please contact admin.");
    clearSession(from);
    return;
  }
  session.categories = categories;
  session.step       = "CATEGORY";
  await sendMenu(from, "📂 Select bill *category*:", "Select Category", categories);
}

async function stepProject(from, session) {
  const projects = await apiPostWithPhoneFallback("user-project-list", {}, session.rawPhone);
  if (!projects || projects.length === 0) {
    await sendText(from, "❌ No projects found. Please contact admin.");
    clearSession(from);
    return;
  }
  session.projects = projects;
  session.step     = "PROJECT";
  await sendMenu(from, "🏗️ Select *project*:", "Select Project", projects);
}

async function stepVendor(from, session) {
  const vendors = await apiPostWithPhoneFallback("vendor-list", {}, session.rawPhone);
  if (!vendors || vendors.length === 0) {
    // No vendors — skip vendor step
    session.supplier_id    = 0;
    session.supplier_label = "-";
    await stepAmount(from, session);
    return;
  }
  session.vendors = vendors;
  session.step    = "VENDOR";

  // Add "None" option at top
  const vendorOptions = [
    { id: "0", title: "None" },
    ...vendors.map((v) => ({
      id:    String(v.id != null ? v.id : v.value),
      title: String(v.title || v.label || v.name || "Unknown"),
    })),
  ];
  await sendMenu(from, "🏪 Select *vendor/supplier* (optional):", "Select Vendor", vendorOptions);
}

async function stepAmount(from, session) {
  session.step = "AMOUNT";
  await sendText(
    from,
    `💰 Enter the *bill amount* (numbers only):\n\nExample: 5000\n\n` +
    `📂 Category: ${session.category_label}\n` +
    `🏗️ Project: ${session.project_label}`
  );
}

async function stepRemarks(from, session) {
  session.step = "REMARKS";
  await sendText(from, "📝 Enter *remarks* (or type *skip* to continue without remarks):");
}

async function stepPhoto(from, session) {
  session.step = "PHOTO";
  await sendText(
    from,
    "📎 Send *bill photos or documents* (optional).\n\nSend multiple files one by one.\nType *done* when finished to submit the bill."
  );
}

async function stepSubmit(from, session) {
  session.step = "SUBMITTING";
  await sendText(from, "⏳ Submitting your bill...");

  const now  = new Date();
  const date = now.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const time = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

  try {
    const result = await apiPostWithPhoneFallback("bill-submit", {
      company_id:  session.company_id,
      date,
      on_time:     time,
      project_id:  session.project_id,
      supplier_id: session.supplier_id || 0,
      category_id: session.category_id,
      amount:      session.amount,
      remarks:     session.remarks || "",
      item:        JSON.stringify(session.files),
    }, session.rawPhone);

    if (result) {
      await sendText(
        from,
        `✅ *Bill Submitted Successfully!*\n\n` +
        `🏢 Company:  ${session.company_label || "-"}\n` +
        `🏗️ Project:  ${session.project_label}\n` +
        `📂 Category: ${session.category_label}\n` +
        `🏪 Vendor:   ${session.supplier_label}\n` +
        `💰 Amount:   Rs.${Number(session.amount || 0).toLocaleString("en-IN")}\n` +
        `📝 Remarks:  ${session.remarks || "-"}\n` +
        `📎 Files:    ${session.files.length > 0 ? session.files.length + " attached" : "None"}\n\n` +
        `Send *hi* to submit another bill.`
      );
    } else {
      await sendText(from, "❌ Bill submission failed. Please try again.\nSend *hi* to restart.");
    }
  } catch (err) {
    console.error("[stepSubmit] error:", err.message);
    await sendText(from, "❌ Bill submission failed. Please try again.\nSend *hi* to restart.");
  }

  clearSession(from);
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN MESSAGE HANDLER
// ═════════════════════════════════════════════════════════════════════════════

async function handleMessage(from, message, contactName) {
  const session = getSession(from, contactName);

  // ── Media files ────────────────────────────────────────────────────────────
  if (["image", "document", "video", "audio"].includes(message.type)) {
    if (session.step === "PHOTO") {
      const mediaId =
        message.image?.id    ||
        message.document?.id ||
        message.video?.id    ||
        message.audio?.id;
      if (mediaId) {
        await sendText(from, "⏳ Processing file...");
        const base64 = await downloadMedia(mediaId);
        if (base64) {
          session.files.push({ id: Date.now(), document: base64 });
          await sendText(from, `✅ File ${session.files.length} received! Send more or type *done* to submit.`);
        } else {
          await sendText(from, "⚠️ Could not process that file. Try again or type *done* to submit.");
        }
      }
      return;
    }
    await sendText(from, "Please follow the current step. Type *cancel* to restart.");
    return;
  }

  // ── Button / List reply ────────────────────────────────────────────────────
  if (message.type === "interactive") {
    const interactive = message.interactive;
    let selectedId    = "";
    let selectedTitle = "";

    if (interactive.type === "button_reply") {
      selectedId    = interactive.button_reply.id;
      selectedTitle = interactive.button_reply.title;
    } else if (interactive.type === "list_reply") {
      selectedId    = interactive.list_reply.id;
      selectedTitle = interactive.list_reply.title;
    }

    // Create Bill button
    if (session.step === "WELCOME" && selectedId === "create_bill") {
      await stepCategory(from, session);
      return;
    }

    // Company selection (if multiple companies)
    if (session.step === "COMPANY") {
      const picked = session.companies.find((c) =>
        String(c.id != null ? c.id : c.value) === selectedId
      );
      if (picked) {
        session.company_id    = String(picked.id != null ? picked.id : picked.value);
        session.company_label = String(picked.title || picked.label || picked.name || "");
        await stepCategory(from, session);
      }
      return;
    }

    // Category selection
    if (session.step === "CATEGORY") {
      const picked = session.categories.find((c) =>
        String(c.id != null ? c.id : c.value) === selectedId
      );
      if (picked) {
        session.category_id    = String(picked.id != null ? picked.id : picked.value);
        session.category_label = String(picked.title || picked.label || picked.name || picked.category_name || "");
        await stepProject(from, session);
      }
      return;
    }

    // Project selection
    if (session.step === "PROJECT") {
      const picked = session.projects.find((p) =>
        String(p.id != null ? p.id : p.value) === selectedId
      );
      if (picked) {
        session.project_id    = String(picked.id != null ? picked.id : picked.value);
        session.project_label = String(picked.title || picked.label || picked.name || picked.project_name || "");
        await stepVendor(from, session);
      }
      return;
    }

    // Vendor selection
    if (session.step === "VENDOR") {
      if (selectedId === "0") {
        session.supplier_id    = 0;
        session.supplier_label = "-";
      } else {
        const picked = session.vendors.find((v) =>
          String(v.id != null ? v.id : v.value) === selectedId
        );
        if (picked) {
          session.supplier_id    = String(picked.id != null ? picked.id : picked.value);
          session.supplier_label = String(picked.title || picked.label || picked.name || picked.vendor_name || picked.supplier_name || "");
        }
      }
      await stepAmount(from, session);
      return;
    }

    return;
  }

  // ── Text messages ──────────────────────────────────────────────────────────
  const text  = String(message.text?.body || "").trim();
  const lower = text.toLowerCase();

  // Cancel anytime
  if (lower === "cancel") {
    clearSession(from);
    await sendText(from, "🔄 Session cancelled. Send *hi* to start again.");
    return;
  }

  switch (session.step) {

    case "START":
      if (["hi", "hello", "hey", "hii", "hai", "helo", "start"].includes(lower)) {
        await stepWelcome(from, session);
      } else {
        await sendText(from, "👋 Send *hi* to get started with ProfitDesk.");
      }
      break;

    case "WELCOME":
      if (["hi", "hello", "hey"].includes(lower)) {
        await stepWelcome(from, session);
      }
      break;

    case "AMOUNT": {
      const amount = parseFloat(text.replace(/,/g, ""));
      if (isNaN(amount) || amount <= 0) {
        await sendText(from, "⚠️ Please enter a valid amount (numbers only).\nExample: *5000*");
      } else {
        session.amount = amount;
        await stepRemarks(from, session);
      }
      break;
    }

    case "REMARKS":
      session.remarks = lower === "skip" ? "" : text;
      await stepPhoto(from, session);
      break;

    case "PHOTO":
      if (lower === "done") {
        await stepSubmit(from, session);
      } else {
        await sendText(from, "📎 Send a file or type *done* to submit the bill.");
      }
      break;

    default:
      if (["hi", "hello", "hey"].includes(lower)) {
        clearSession(from);
        await stepWelcome(from, getSession(from, contactName));
      } else {
        await sendText(from, "👋 Send *hi* to get started.");
      }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WEBHOOK VERIFICATION — GET /webhook/whatsapp
// ═════════════════════════════════════════════════════════════════════════════

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
          try {
            await handleMessage(message.from, message, contactName);
          } catch (err) {
            console.error("WhatsApp handler error:", err);
          }
        }
      }
    }
  })().catch(console.error);
});

module.exports = router;