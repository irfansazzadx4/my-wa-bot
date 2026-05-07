const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const http = require("http");
const qrcode = require("qrcode");

// ১. Render Port Binding + QR Server
const PORT = process.env.PORT || 3000;
let lastQR = "";
let isConnected = false;

http.createServer(async (req, res) => {
    if (isConnected) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="text-align:center;background:#111;color:#0f0;font-family:sans-serif">
            <h2>✅ WhatsApp Bot Connected!</h2>
            <p>বট সফলভাবে কানেক্ট হয়েছে।</p>
        </body></html>`);
    } else if (lastQR) {
        try {
            const qrImage = await qrcode.toDataURL(lastQR);
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`<html><body style="text-align:center;background:#111;color:#fff;font-family:sans-serif">
                <h2>📱 WhatsApp QR Code</h2>
                <img src="${qrImage}" style="width:280px;border:4px solid #25D366;border-radius:12px"/>
                <p>WhatsApp → Linked Devices → Link a Device → QR Scan করুন</p>
                <p style="color:orange">⚠️ QR মেয়াদ শেষ হলে page refresh করুন</p>
                <meta http-equiv="refresh" content="30">
            </body></html>`);
        } catch (e) {
            res.writeHead(500);
            res.end("QR generate error");
        }
    } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="text-align:center;background:#111;color:#fff;font-family:sans-serif">
            <h2>⏳ QR লোড হচ্ছে...</h2>
            <p>১০ সেকেন্ড পর page refresh হবে</p>
            <meta http-equiv="refresh" content="10">
        </body></html>`);
    }
}).listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }),
        browser: ["Chrome (Linux)", "Chrome", "121.0.0"],
        version,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            lastQR = qr;
            isConnected = false;
            console.log("✅ QR Ready! Browser এ গিয়ে scan করুন।");
        }

        if (connection === "open") {
            lastQR = "";
            isConnected = true;
            console.log("✅ WhatsApp Bot সফলভাবে কানেক্ট হয়েছে!");
        }

        if (connection === "close") {
            isConnected = false;
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log("❌ কানেকশন বন্ধ। কারণ কোড:", reason);

            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 পুনরায় কানেক্ট করা হচ্ছে...");
                startBot();
            } else {
                console.log("🚫 লগ আউট হয়েছে। auth_info_baileys ফোল্ডার মুছে নতুন করে deploy করুন।");
            }
        }
    });

    // মেসেজ হ্যান্ডেলিং
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;

        const msgText = m.message.conversation || m.message.extendedTextMessage?.text;
        const remoteJid = m.key.remoteJid;

        if (msgText === ".ping") {
            await sock.sendMessage(remoteJid, { text: "Pong! 🏓 বট সচল আছে।" });
        }
    });
}

startBot().catch(err => console.error("Critical Error:", err));
