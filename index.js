const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    delay,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jmp
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }),
        browser: ["Ubuntu", "Chrome", "121.0.6167.184"], // Updated Browser
        version
    });

    // Pairing Code System
    if (!sock.authState.creds.registered) {
        const phoneNumber = "8801846649326"; // আপনার হোয়াটসঅ্যাপ নম্বর
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log("\n---------------------------------------");
                console.log(`📱 আপনার হোয়াটসঅ্যাপ পেয়ারিং কোড: ${code}`);
                console.log("---------------------------------------\n");
            } catch (error) {
                console.error("Pairing Code Error:", error);
            }
        }, 5000); 
    }

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log("কানেকশন বন্ধ হয়েছে, পুনরায় চেষ্টা করা হচ্ছে...", shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            console.log("✅ বট সফলভাবে সচল হয়েছে!");
        }
    });

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

startBot().catch(err => console.log("Error: " + err));
