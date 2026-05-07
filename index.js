const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const http = require("http");

// ১. Render Port Binding Fix (যাতে সার্ভার বন্ধ না হয়)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WhatsApp Bot is running...\n');
}).listen(PORT, () => {
    console.log(`✅ Fake server running on port ${PORT}`);
});

async function startBot() {
    // সেশন সেভ করার জন্য ফোল্ডার
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: true, // টার্মিনালে QR Code দেখাবে
        logger: pino({ level: "fatal" }),
        browser: ["Ubuntu", "Chrome", "121.0.6167.184"],
        version
    });

    // ২. Pairing Code Logic (যদি QR স্ক্যান করতে না চান)
    if (!sock.authState.creds.registered) {
        const phoneNumber = "8801846649326"; // আপনার নম্বরটি এখানে নিশ্চিত করুন
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log("\n---------------------------------------");
                console.log(`📱 pairing Code (Phone): ${code}`);
                console.log("---------------------------------------\n");
            } catch (error) {
                console.error("Pairing Code Error:", error);
            }
        }, 10000); // ১০ সেকেন্ড সময় দেওয়া হলো সকেট রেডি হতে
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // টার্মিনালে QR কোড প্রিন্ট করার ব্যাকআপ লজিক
        if (qr) {
            console.log("⬇️ নিচের QR কোডটি স্ক্যান করুন ⬇️");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log("❌ কানেকশন বন্ধ হয়েছে। কারণ কোড:", reason);
            
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 পুনরায় কানেক্ট করার চেষ্টা করা হচ্ছে...");
                startBot();
            } else {
                console.log("🚫 লগ আউট হয়েছে। অনুগ্রহ করে auth_info_baileys ফোল্ডারটি মুছে আবার রান করুন।");
            }
        } else if (connection === "open") {
            console.log("✅ হোয়াটসঅ্যাপ বট সফলভাবে কানেক্ট হয়েছে!");
        }
    });

    // ৩. মেসেজ হ্যান্ডেলিং (টেস্ট করার জন্য)
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

// বট স্টার্ট করুন
startBot().catch(err => console.error("Critical Error:", err));
