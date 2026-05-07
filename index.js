const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const http = require("http");

// Render Port Binding Fix
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is running properly...\n');
}).listen(PORT);

async function startBot() {
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
        version
    });

    // পেয়ারিং কোড সিস্টেম
    if (!sock.authState.creds.registered) {
        const phoneNumber = "8801846649326"; 
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log("\n=======================================");
                console.log(`📱 YOUR PAIRING CODE: ${code}`);
                console.log("=======================================\n");
            } catch (error) {
                console.error("Pairing Code Error:", error);
            }
        }, 8000); 
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        } else if (connection === "open") {
            console.log("✅ Bot Connected Successfully!");
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const m = messages[0];
        if (!m.message || m.key.fromMe) return;
        const msgText = m.message.conversation || m.message.extendedTextMessage?.text;
        if (msgText === ".ping") {
            await sock.sendMessage(m.key.remoteJid, { text: "Pong! 🏓" });
        }
    });
}

startBot().catch(err => console.error("Error:", err));
