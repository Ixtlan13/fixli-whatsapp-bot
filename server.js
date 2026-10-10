require("dotenv").config();
const express = require("express");
const QRCode = require("qrcode");
const { OpenAI } = require("openai");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { SYSTEM_PROMPT } = require("./system_prompt");

const app = express();
const PORT = process.env.PORT || 3000;

let currentQR = null;
let isConnected = false;
let waSock = null;
let lastUpsertEvent = null;
let lastIncomingMessage = null;
let lastOutgoingMessage = null;
const messageStore = new Map();

// Determine AI Provider (Google Gemini is 100% free; fallback to OpenAI)
const rawKey = (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
const isGemini =
  !!process.env.GEMINI_API_KEY ||
  rawKey.startsWith("AIzaSy") ||
  rawKey.startsWith("AQ.") ||
  process.env.AI_PROVIDER === "gemini";

const AI_MODEL = isGemini
  ? (process.env.GEMINI_MODEL || "gemini-flash-latest")
  : (process.env.OPENAI_MODEL || "gpt-4o-mini");

console.log(`[AI CONFIG] Provider: ${isGemini ? "Google Gemini (FREE)" : "OpenAI"}, Model: ${AI_MODEL}`);

// OpenAI client (compatible with both OpenAI and Google Gemini endpoint)
const openai = new OpenAI({
  apiKey: rawKey || "YOUR_KEY",
  baseURL: isGemini ? "https://generativelanguage.googleapis.com/v1beta/openai/" : undefined
});

// In-memory conversation history per customer phone: Map<phone, Array<{role, content}>>
const conversations = new Map();

// Helper to notify Dima via Telegram or WhatsApp
async function notifyDima(leadText, customerPhone) {
  console.log(`\n🔥 [NEW QUALIFIED LEAD] from ${customerPhone}:\n${leadText}\n`);
  
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID) {
    try {
      const tgUrl = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
      const body = {
        chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
        text: `⚡️ Новая заявка Fixli в WhatsApp!\nНомер клиента: +${customerPhone}\n\n${leadText}`
      };
      await fetch(tgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      console.log("Sent lead alert to Telegram!");
    } catch (e) {
      console.error("Failed to send Telegram alert:", e.message);
    }
  }

  if (process.env.DIMA_PERSONAL_PHONE && waSock && isConnected) {
    try {
      const dimaJid = `${process.env.DIMA_PERSONAL_PHONE.replace(/\D/g, "")}@s.whatsapp.net`;
      await waSock.sendMessage(dimaJid, {
        text: `⚡️ Новая заявка Fixli в WhatsApp!\nКлиент: https://wa.me/${customerPhone}\n\n${leadText}`
      });
      console.log("Forwarded lead to Dima WhatsApp!");
    } catch (e) {
      console.error("Failed to forward lead to Dima WhatsApp:", e.message);
    }
  }
}

// Start WhatsApp Baileys connection
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  waSock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: true,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 15000,
    getMessage: async (key) => {
      return messageStore.get(key.id) || undefined;
    }
  });

  waSock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      console.log("\n[QR CODE UPDATED] Fresh QR code ready for scan");
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("Connection closed, status:", statusCode, "reconnecting:", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === "open") {
      isConnected = true;
      currentQR = null;
      console.log("✅ WhatsApp connected successfully to Fixli line! User:", JSON.stringify(waSock.user));
    }
  });

  waSock.ev.on("creds.update", saveCreds);

  // Incoming message handler
  waSock.ev.on("messages.upsert", async (m) => {
    lastUpsertEvent = { time: new Date().toISOString(), type: m.type, count: m.messages?.length };
    if (!m.messages || !m.messages.length) return;

    for (const msg of m.messages) {
      if (!msg || !msg.message) continue;
      if (msg.key?.id) messageStore.set(msg.key.id, msg.message);

      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || remoteJid.includes("@g.us") || remoteJid.includes("status@broadcast")) continue;

      const customerPhone = remoteJid.replace("@s.whatsapp.net", "");

      // Robust unwrap of wrapped messages (ephemeral, viewOnce, document captions)
      const content =
        msg.message.ephemeralMessage?.message ||
        msg.message.viewOnceMessage?.message ||
        msg.message.viewOnceMessageV2?.message ||
        msg.message.documentWithCaptionMessage?.message ||
        msg.message;

      const text =
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        "";

      console.log(`[RAW MSG] fromMe: ${msg.key.fromMe}, jid: ${remoteJid}, text: ${text || "<empty/media>"}`);

      if (msg.key.fromMe) continue;
      if (!text || !text.trim()) continue;

      lastIncomingMessage = { time: new Date().toISOString(), from: customerPhone, text };
      console.log(`\n💬 [INCOMING] +${customerPhone}: ${text}`);

      if (!conversations.has(customerPhone)) {
        conversations.set(customerPhone, []);
      }
      const history = conversations.get(customerPhone);
      history.push({ role: "user", content: text });

      if (history.length > 20) {
        history.splice(0, history.length - 20);
      }

      try {
        await waSock.sendPresenceUpdate("composing", remoteJid);

        console.log(`[AI] Generating response for +${customerPhone} using ${AI_MODEL}...`);

        const response = await openai.chat.completions.create({
          model: AI_MODEL,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
          temperature: 0.6,
          max_tokens: 300
        });

        const reply = response.choices[0]?.message?.content || "";
        let clientText = reply;

        if (reply.includes("[LEAD_DATA]")) {
          const leadMatch = reply.match(/\[LEAD_DATA\]([\s\S]*?)\[\/LEAD_DATA\]/);
          if (leadMatch) {
            const leadData = leadMatch[1].trim();
            notifyDima(leadData, customerPhone);
            clientText = reply.replace(/\[LEAD_DATA\][\s\S]*?\[\/LEAD_DATA\]/, "").trim();
          }
        }

        history.push({ role: "assistant", content: clientText });

        await new Promise((r) => setTimeout(r, 1000));
        await waSock.sendMessage(remoteJid, { text: clientText });
        lastOutgoingMessage = { time: new Date().toISOString(), to: customerPhone, text: clientText };
        console.log(`✅ [OUTGOING SENT] +${customerPhone}: ${clientText}\n`);
      } catch (err) {
        console.error(`❌ [AI / SEND ERROR] +${customerPhone}:`, err.message);
        try {
          const fallbackText = "שלום! קיבלנו את פנייתך ב-Fixli. מומחה מטעמנו יחזור אליך בהקדם האפשרי. / Здравствуйте! Мы получили ваше обращение в Fixli. Мастер свяжется с вами в ближайшее время.";
          await waSock.sendMessage(remoteJid, { text: fallbackText });
          lastOutgoingMessage = { time: new Date().toISOString(), to: customerPhone, text: fallbackText, error: err.message };
        } catch (e) {
          console.error("Failed to send fallback reply:", e.message);
        }
      }
    }
  });
}

// Pairing Code endpoint
app.get("/pair", async (req, res) => {
  const phone = req.query.phone || "972552947783";
  const cleanPhone = phone.replace(/\D/g, "");
  
  if (!waSock) {
    return res.status(500).json({ error: "WhatsApp сервис еще инициализируется, подождите пару секунд" });
  }
  if (isConnected) {
    return res.json({ error: "WhatsApp уже подключен!", user: waSock.user });
  }

  try {
    const code = await waSock.requestPairingCode(cleanPhone);
    console.log(`[PAIRING CODE GENERATED] for +${cleanPhone}: ${code}`);
    res.json({ success: true, code });
  } catch (err) {
    console.error("Pairing code error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic endpoint to verify AI credentials
app.get("/test-ai", async (req, res) => {
  try {
    const keyPreview = rawKey.length > 8 ? `${rawKey.slice(0, 7)}...${rawKey.slice(-4)}` : "NOT_SET";
    const response = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [{ role: "user", content: "Ответь одним словом: РАБОТАЕТ" }],
      max_tokens: 10
    });
    res.json({
      status: "ok",
      provider: isGemini ? "Google Gemini (FREE)" : "OpenAI",
      model: AI_MODEL,
      apiKeyConfigured: keyPreview,
      reply: response.choices[0]?.message?.content
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      provider: isGemini ? "Google Gemini (FREE)" : "OpenAI",
      model: AI_MODEL,
      message: err.message
    });
  }
});

// Check if a phone number exists on WhatsApp
app.get("/check-phone", async (req, res) => {
  const phone = req.query.phone || "972532464636";
  const cleanPhone = phone.replace(/\D/g, "");
  if (!waSock || !isConnected) {
    return res.status(500).json({ error: "WhatsApp not connected" });
  }
  try {
    const result = await waSock.onWhatsApp(cleanPhone);
    res.json({ queried: cleanPhone, result, myUser: waSock.user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset session cleanly
app.get("/reset-session", async (req, res) => {
  const fs = require("fs");
  const path = require("path");
  try {
    if (waSock) {
      try { waSock.end(); } catch (e) {}
    }
    isConnected = false;
    currentQR = null;
    const authDir = path.join(__dirname, "auth_info_baileys");
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    fs.mkdirSync(authDir, { recursive: true });
    setTimeout(() => {
      connectToWhatsApp();
    }, 1500);
    res.json({ success: true, message: "Сессия успешно сброшена! Откройте /qr для новой чистой привязки." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint: inspect logged-in WhatsApp account and recent events
app.get("/debug", (req, res) => {
  res.json({
    connected: isConnected,
    user: waSock?.user || null,
    qrAvailable: !!currentQR,
    aiModel: AI_MODEL,
    isGemini: isGemini,
    lastUpsertEvent,
    lastIncomingMessage,
    lastOutgoingMessage
  });
});

// Send test message endpoint: send direct message to any phone via WhatsApp
app.get("/send-test", async (req, res) => {
  const phone = req.query.phone || "972532464636";
  const cleanPhone = phone.replace(/\D/g, "");
  const jid = `${cleanPhone}@s.whatsapp.net`;

  if (!waSock || !isConnected) {
    return res.status(500).json({ error: "WhatsApp не подключен", isConnected });
  }

  try {
    const text = req.query.text || "⚡️ Привет! Это тестовое сообщение от Fixli бота. Связь работает!";
    const result = await waSock.sendMessage(jid, { text });
    res.json({ success: true, target: jid, messageId: result?.key?.id, sender: waSock.user });
  } catch (err) {
    res.status(500).json({ error: err.message, sender: waSock?.user });
  }
});

// Web UI for monitoring and QR scan
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="utf-8">
      <title>Fixli AI Assistant</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #fff; padding: 40px 20px; text-align: center; }
        .card { background: #151c2c; max-width: 500px; margin: 0 auto; padding: 30px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.08); }
        .badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-weight: bold; font-size: 14px; margin-bottom: 20px; }
        .badge.online { background: #10b981; color: #fff; }
        .badge.waiting { background: #f59e0b; color: #fff; }
        a.btn { display: inline-block; margin-top: 20px; background: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; }
        a.btn-danger { display: inline-block; margin-top: 10px; background: #dc2626; color: #fff; padding: 8px 16px; text-decoration: none; border-radius: 6px; font-size: 13px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Fixli AI Assistant</h1>
        <div class="badge ${isConnected ? "online" : "waiting"}">
          ${isConnected ? "● ОНЛАЙН 24/7" : "ОЖИДАНИЕ ПРИВЯЗКИ WHATSAPP"}
        </div>
        <p>${isConnected ? "WhatsApp подключен к номеру Fixli (" + (waSock?.user?.id || "") + "). Бот принимает входящие заявки и отвечает через " + (isGemini ? "Google Gemini (FREE)" : "GPT-4o") + "." : "WhatsApp не привязан. Нажмите кнопку ниже для привязки через QR или код."}</p>
        ${!isConnected ? '<a class="btn" href="/qr">Открыть страницу привязки</a>' : '<p style="color:#10b981;">Все системы работают в штатном режиме.</p>'}
        <br><br>
        <a class="btn-danger" href="/reset-session" onclick="return confirm('Сбросить авторизацию WhatsApp для новой чистой привязки?')">Перепривязать WhatsApp (Сброс)</a>
      </div>
    </body>
    </html>
  `);
});

app.get("/qr", (req, res) => {
  if (isConnected) {
    return res.send(`
      <body style="background:#0b0f19;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
        <h2 style="color:#10b981;">WhatsApp уже подключен!</h2>
        <p>Аккаунт: ${waSock?.user?.id || "Fixli"}</p>
        <p>Бот активен и отвечает на сообщения.</p>
        <a href="/" style="color:#60a5fa;">Вернуться на главную</a>
        <br><br>
        <a href="/reset-session" style="color:#ef4444;font-size:13px;" onclick="return confirm('Сбросить сессию?')">Сбросить сессию и привязать заново</a>
      </body>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="utf-8">
      <title>Привязка WhatsApp Fixli</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { background: #0b0f19; color: #fff; text-align: center; font-family: -apple-system, sans-serif; padding: 30px 15px; }
        .box { background: #151c2c; max-width: 440px; margin: 0 auto; padding: 25px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); }
        img { border-radius: 12px; margin: 15px 0; max-width: 280px; width: 100%; background: #fff; padding: 10px; }
        .btn { background: #10b981; color: #fff; border: none; padding: 12px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 15px; margin-top: 10px; width: 100%; }
        .code-box { font-size: 32px; letter-spacing: 6px; color: #38bdf8; font-weight: bold; margin: 15px 0; font-family: monospace; background: #0b0f19; padding: 12px; border-radius: 8px; border: 1px dashed #38bdf8; }
        .divider { border-top: 1px solid rgba(255,255,255,0.1); margin: 25px 0; position: relative; }
        .divider span { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: #151c2c; padding: 0 10px; color: #94a3b8; font-size: 12px; }
      </style>
      <script>
        setInterval(async () => {
          try {
            const res = await fetch('/status');
            const data = await res.json();
            if (data.connected) {
              location.href = '/';
              return;
            }
            if (data.qr) {
              const img = document.getElementById('qrImg');
              if (img) img.src = data.qr;
            }
          } catch(e) {}
        }, 3000);

        async function requestPairingCode() {
          const btn = document.getElementById('pairBtn');
          const codeEl = document.getElementById('pairingCodeDisplay');
          btn.disabled = true;
          btn.innerText = 'Запрашиваю 8-значный код...';
          codeEl.style.display = 'block';
          codeEl.innerText = '...';

          try {
            const res = await fetch('/pair?phone=972552947783');
            const data = await res.json();
            if (data.code) {
              codeEl.innerText = data.code;
              btn.innerText = 'Код получен! Введите его в WhatsApp';
            } else {
              codeEl.innerText = data.error || 'Ошибка';
              btn.disabled = false;
              btn.innerText = 'Попробовать снова';
            }
          } catch(e) {
            codeEl.innerText = 'Ошибка соединения';
            btn.disabled = false;
          }
        }
      </script>
    </head>
    <body>
      <div class="box">
        <h2>Привязка WhatsApp Fixli</h2>
        <p style="font-size:13px;color:#94a3b8;">Способ 1: Отсканируйте свежий QR-код через камеру (он обновляется сам):</p>
        <img id="qrImg" src="${currentQR || ""}" alt="WhatsApp QR Code" />

        <div class="divider"><span>ИЛИ БЕЗ КАМЕРЫ</span></div>

        <p style="font-size:13px;color:#94a3b8;">Способ 2: Привязка по 8-значному коду для +972 55-294-7783:</p>
        <button id="pairBtn" class="btn" onclick="requestPairingCode()">Получить 8-значный код</button>
        <div id="pairingCodeDisplay" class="code-box" style="display:none;"></div>
        <p style="font-size:12px;color:#64748b;margin-top:8px;">В WhatsApp на телефоне: Связанные устройства → Привязать устройство → «Привязать по номеру телефона» → введите этот код.</p>
      </div>
    </body>
    </html>
  `);
});

app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    qrAvailable: !!currentQR,
    qr: currentQR,
    user: waSock?.user || null
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

const MAIN_PORT = process.env.PORT || 8080;
app.listen(MAIN_PORT, "0.0.0.0", () => {
  console.log(`Server listening on 0.0.0.0:${MAIN_PORT}`);
  connectToWhatsApp();
});

if (MAIN_PORT != 3000) {
  try {
    app.listen(3000, "0.0.0.0", () => {
      console.log("Server also listening on 0.0.0.0:3000");
    });
  } catch (e) {}
}
