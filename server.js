require("dotenv").config();
const express = require("express");
const QRCode = require("qrcode");
const { OpenAI } = require("openai");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { SYSTEM_PROMPT } = require("./system_prompt");

const app = express();
const PORT = process.env.PORT || 3000;

let currentQR = null;
let isConnected = false;
let waSock = null;

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "YOUR_OPENAI_API_KEY"
});

// In-memory conversation history per customer phone: Map<phone, Array<{role, content}>>
const conversations = new Map();

// Helper to notify Dima via Telegram or WhatsApp
async function notifyDima(leadText, customerPhone) {
  console.log(`\n🔥 [NEW QUALIFIED LEAD] from ${customerPhone}:\n${leadText}\n`);
  
  // 1. If Telegram Bot Token & Chat ID provided, send instant message
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

  // 2. If Dima's personal WhatsApp number configured, forward lead to him
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
    printQRInTerminal: true,
    logger: pino({ level: "silent" }),
    browser: ["Fixli AI", "Chrome", "1.0.0"]
  });

  waSock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await QRCode.toDataURL(qr);
      console.log("\n[QR CODE READY] Scan via http://localhost:" + PORT + "/qr or terminal");
    }

    if (connection === "close") {
      isConnected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(
        "Connection closed due to:",
        lastDisconnect?.error,
        ", reconnecting:",
        shouldReconnect
      );
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === "open") {
      isConnected = true;
      currentQR = null;
      console.log("✅ WhatsApp connected successfully to Fixli line!");
    }
  });

  waSock.ev.on("creds.update", saveCreds);

  // Incoming message handler
  waSock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg || !msg.message || msg.key.fromMe) return;

    // Ignore status broadcasts and groups
    const remoteJid = msg.key.remoteJid;
    if (remoteJid.includes("@g.us") || remoteJid.includes("status@broadcast")) return;

    const customerPhone = remoteJid.replace("@s.whatsapp.net", "");
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      "";

    if (!text.trim()) return;

    console.log(`[INCOMING] +${customerPhone}: ${text}`);

    // Manage conversation history
    if (!conversations.has(customerPhone)) {
      conversations.set(customerPhone, []);
    }
    const history = conversations.get(customerPhone);
    history.push({ role: "user", content: text });

    // Keep last 10 turns
    if (history.length > 20) {
      history.splice(0, history.length - 20);
    }

    try {
      // Show "typing..." indicator in WhatsApp
      await waSock.sendPresenceUpdate("composing", remoteJid);

      // Call OpenAI
      const response = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
        temperature: 0.6,
        max_tokens: 300
      });

      const reply = response.choices[0]?.message?.content || "";
      let clientText = reply;

      // Check if lead data is present in response
      if (reply.includes("[LEAD_DATA]")) {
        const leadMatch = reply.match(/\[LEAD_DATA\]([\s\S]*?)\[\/LEAD_DATA\]/);
        if (leadMatch) {
          const leadData = leadMatch[1].trim();
          notifyDima(leadData, customerPhone);
          clientText = reply.replace(/\[LEAD_DATA\][\s\S]*?\[\/LEAD_DATA\]/, "").trim();
        }
      }

      history.push({ role: "assistant", content: clientText });

      // Simulate natural typing delay (1.5 - 2.5s)
      await new Promise((r) => setTimeout(r, 1800));

      // Send WhatsApp message back to client
      await waSock.sendMessage(remoteJid, { text: clientText });
      console.log(`[OUTGOING] +${customerPhone}: ${clientText}`);
    } catch (err) {
      console.error("Error processing message:", err.message);
    }
  });
}

// Web UI for monitoring and QR scan
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="utf-8">
      <title>Fixli WhatsApp GPT Bot</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #fff; padding: 40px 20px; text-align: center; }
        .card { background: #151c2c; max-width: 500px; margin: 0 auto; padding: 30px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.08); }
        .badge { display: inline-block; padding: 6px 14px; border-radius: 20px; font-weight: bold; font-size: 14px; margin-bottom: 20px; }
        .badge.online { background: #10b981; color: #fff; }
        .badge.waiting { background: #f59e0b; color: #fff; }
        a.btn { display: inline-block; margin-top: 20px; background: #2563eb; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Fixli AI Assistant</h1>
        <div class="badge ${isConnected ? "online" : "waiting"}">
          ${isConnected ? "● ОНЛАЙН 24/7" : "ОЖИДАНИЕ СКАНА QR"}
        </div>
        <p>${isConnected ? "WhatsApp подключен к номеру Fixli. Бот принимает входящие заявки и отвечает через GPT-4o-mini." : "WhatsApp не привязан. Отсканируйте QR-код для привязки номера."}</p>
        ${!isConnected ? '<a class="btn" href="/qr">Открыть QR-код для скана</a>' : '<p style="color:#10b981;">Все системы работают в штатном режиме.</p>'}
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
        <p>Бот активен и отвечает на сообщения.</p>
        <a href="/" style="color:#60a5fa;">Вернуться на главную</a>
      </body>
    `);
  }

  if (!currentQR) {
    return res.send(`
      <body style="background:#0b0f19;color:#fff;text-align:center;padding:50px;font-family:sans-serif;">
        <h2>Генерация QR-кода...</h2>
        <p>Пожалуйста, обновите страницу через 3 секунды.</p>
        <script>setTimeout(() => location.reload(), 3000);</script>
      </body>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Сканирование QR-кода Fixli WhatsApp</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { background: #0b0f19; color: #fff; text-align: center; font-family: -apple-system, sans-serif; padding: 30px 15px; }
        .box { background: #151c2c; max-width: 420px; margin: 0 auto; padding: 25px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); }
        img { border-radius: 12px; margin: 15px 0; max-width: 100%; background: #fff; padding: 10px; }
      </style>
      <script>
        setInterval(async () => {
          const res = await fetch('/status');
          const data = await res.json();
          if (data.connected) location.href = '/';
        }, 3000);
      </script>
    </head>
    <body>
      <div class="box">
        <h2>Привязка WhatsApp Fixli</h2>
        <p style="font-size:14px;color:#94a3b8;">Откройте WhatsApp на телефоне Димы → Настройки → Связанные устройства → Привязка устройства</p>
        <img src="${currentQR}" alt="WhatsApp QR Code" />
        <p style="font-size:12px;color:#64748b;">Страница автоматически обновится после сканирования</p>
      </div>
    </body>
    </html>
  `);
});

app.get("/status", (req, res) => {
  res.json({ connected: isConnected, qrAvailable: !!currentQR });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  connectToWhatsApp();
});
