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
const http = require("http");

// ১. Render Port Binding Fix (যাতে সার্ভার বন্ধ না হয়)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WhatsApp Bot is running properly...\n');
}).listen(PORT, () => {
    console.log(`✅ Fake server running on port ${PORT}`);
});

async function startBot() {
    // সেশন সেভ করার জন্য ফোল্ডার (GitHub এ এই ফোল্ডারটি পুশ করবেন না)
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: false, // QR কোড ভেঙে যায় তাই এটি বন্ধ রাখা হয়েছে
        logger: pino({ level: "fatal" }),
        browser: ["Ubuntu", "Chrome", "121.0.6167.184"],
        version,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
    });

    // ২. শক্তিশালী পেয়ারিং কোড লজিক
    if (!sock.authState.creds.registered) {
        console.log("⏳ পেয়ারিং কোড তৈরির চেষ্টা করা হচ্ছে... ১৫ সেকেন্ড অপেক্ষা করুন।");
        
        setTimeout(async () => {
            try {
                const phoneNumber = "8801846649326"; // আপনার নম্বর
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                
                console.log("\n=======================================");
                console.log(`📱 আপনার পেয়ারিং কোড: ${code}`);
                console.log("=======================================\n");
            } catch (error) {
                console.error("❌ পেয়ারিং কোড এরর:", error.message);
                console.log("পরামর্শ: Render থেকে 'Clear Build Cache & Deploy' দিন।");
            }
        }, 5000); // সকেট স্ট্যাবল হওয়ার জন্য ১৫ সেকেন্ড সময় দেওয়া হলো
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log("❌ কানেকশন বন্ধ হয়েছে। কারণ কোড:", reason);
            
            if (reason !== DisconnectReason.loggedOut) {
                console.log("🔄 পুনরায় কানেক্ট করার চেষ্টা করা হচ্ছে...");
                startBot();
            } else {
                console.log("🚫 লগ আউট হয়েছে। অনুগ্রহ করে নতুন করে পেয়ারিং কোড নিন।");
            }
        } else if (connection === "open") {
            console.log("✅ হোয়াটসঅ্যাপ বট সফলভাবে কানেক্ট হয়েছে!");
        }
    });

    // ৩. মেসেজ হ্যান্ডেলিং (টেস্ট কমান্ড: .ping)
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

// প্রসেস শুরু করুন
startBot().catch(err => console.error("Critical Error:", err));
