const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");
const http = require("http");
const qrcode = require("qrcode");
const { execSync } = require("child_process");
const FormData = require("form-data");
const axios = require("axios");

// ====== CONFIG ======
const API_EXTRACT_URL = "https://server24.kesug.com/Signtonid_api_one.php";
const API_GENERATE_URL = "https://server24.kesug.com/bot/nid-bn.php";
const BASE_URL = "https://server24.kesug.com/bot/storage/";
const STORAGE_DIR = "/tmp/nid_storage/";

// ====== SERVER ======
const PORT = process.env.PORT || 3000;
let lastQR = "";
let isConnected = false;

const fs = require("fs");
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

http.createServer(async (req, res) => {
    if (isConnected) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="text-align:center;background:#111;color:#0f0;font-family:sans-serif">
            <h2>✅ WhatsApp Bot Connected!</h2></body></html>`);
    } else if (lastQR) {
        try {
            const qrImage = await qrcode.toDataURL(lastQR);
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`<html><body style="text-align:center;background:#111;color:#fff;font-family:sans-serif">
                <h2>📱 WhatsApp QR Code</h2>
                <img src="${qrImage}" style="width:280px;border:4px solid #25D366;border-radius:12px"/>
                <p>WhatsApp → Linked Devices → Link a Device → QR Scan করুন</p>
                <meta http-equiv="refresh" content="30">
            </body></html>`);
        } catch (e) { res.writeHead(500); res.end("QR error"); }
    } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="text-align:center;background:#111;color:#fff;font-family:sans-serif">
            <h2>⏳ QR লোড হচ্ছে...</h2>
            <meta http-equiv="refresh" content="10">
        </body></html>`);
    }
}).listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ====== GITHUB SESSION SAVE ======
async function pushSessionToGitHub() {
    try {
        const repo = process.env.GITHUB_REPO;
        const token = process.env.GITHUB_TOKEN;
        const branch = process.env.GITHUB_BRANCH || "main";
        if (!repo || !token) return;

        execSync(`git config --global user.email "bot@bot.com"`);
        execSync(`git config --global user.name "WA Bot"`);
        const remoteUrl = `https://${token}@github.com/${repo}.git`;
        try {
            execSync(`git remote get-url origin`);
            execSync(`git remote set-url origin ${remoteUrl}`);
        } catch {
            execSync(`git remote add origin ${remoteUrl}`);
        }
        execSync(`git add -f auth_info_baileys/`);
        execSync(`git commit -m "session update" --allow-empty`);
        execSync(`git push origin ${branch} --force`);
        console.log("✅ Session GitHub এ save হয়েছে!");
    } catch (e) {
        console.log("⚠️ Session push error:", e.message);
    }
}

// ====== NID PROCESSING ======
async function extractNIDFromPDF(pdfBuffer) {
    const form = new FormData();
    form.append("pdf", pdfBuffer, {
        filename: "nid.pdf",
        contentType: "application/pdf",
    });

    const response = await axios.post(API_EXTRACT_URL, form, {
        headers: form.getHeaders(),
        timeout: 60000,
    });

    return response.data;
}

async function generateNIDCard(data) {
    const params = new URLSearchParams();
    params.append("nid", data.nationalId || "");
    params.append("pin", "");
    params.append("pin_status", "disabled");
    params.append("nameBangla", data.nameBangla || "");
    params.append("nameEnglish", data.nameEnglish || "");
    params.append("dob", data.dateOfBirth || "");
    params.append("birthPlace", data.birthPlace || "");
    params.append("nameFather", data.fatherName || "");
    params.append("nameMother", data.motherName || "");
    params.append("bloodGroup", data.bloodGroup || "");
    params.append("fulladdress", data.address || "");
    params.append("imageUrl12", data.userIMG || "");
    params.append("imageUrl22", data.signIMG || "");
    params.append("issueDate", new Date().toLocaleDateString("en-GB"));

    const response = await axios.post(API_GENERATE_URL, params.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 30000,
    });

    if (!response.data || response.data.length < 100) {
        throw new Error("Empty HTML response from card generator");
    }

    // HTML file save করো server এ
    const filename = Date.now() + "_card.html";
    const filepath = STORAGE_DIR + filename;
    fs.writeFileSync(filepath, response.data);

    return BASE_URL + filename;
}

// ====== MAIN BOT ======
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
            console.log("✅ QR Ready!");
        }

        if (connection === "open") {
            lastQR = "";
            isConnected = true;
            console.log("✅ WhatsApp Bot Connected!");
            await pushSessionToGitHub();
        }

        if (connection === "close") {
            isConnected = false;
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log("❌ Connection closed. Code:", reason);
            if (reason !== DisconnectReason.loggedOut) {
                startBot();
            }
        }
    });

    // ====== MESSAGE HANDLER ======
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue;

            const from = m.key.remoteJid;
            const msgType = Object.keys(m.message)[0];

            // .ping কমান্ড
            const textMsg = m.message.conversation || m.message.extendedTextMessage?.text || "";
            if (textMsg.trim() === ".ping") {
                await sock.sendMessage(from, { text: "Pong! 🏓 বট সচল আছে।" });
                continue;
            }

            // PDF document handle
            if (msgType === "documentMessage") {
                const doc = m.message.documentMessage;
                const mimetype = doc.mimetype || "";

                if (!mimetype.includes("pdf")) {
                    await sock.sendMessage(from, {
                        text: "❌ শুধুমাত্র PDF ফাইল পাঠান।\n\nআপনার NID-এর PDF ফাইলটি পাঠান।",
                    }, { quoted: m });
                    continue;
                }

                try {
                    // Processing message পাঠাও
                    await sock.sendMessage(from, {
                        text: "⏳ আপনার NID প্রক্রিয়া করা হচ্ছে...\nঅনুগ্রহ করে একটু অপেক্ষা করুন।",
                    }, { quoted: m });

                    // PDF download করো
                    console.log("📥 PDF downloading...");
                    const pdfBuffer = await downloadMediaMessage(m, "buffer", {});
                    console.log("✅ PDF downloaded, size:", pdfBuffer.length);

                    // Extract data
                    console.log("🔍 Extracting NID data...");
                    const extractResult = await extractNIDFromPDF(pdfBuffer);

                    if (extractResult.status !== "success" || !extractResult.data) {
                        await sock.sendMessage(from, {
                            text: "❌ PDF থেকে তথ্য পড়া সম্ভব হয়নি।\n\nনিশ্চিত করুন যে এটি বাংলাদেশ NID-এর অরিজিনাল PDF।",
                        }, { quoted: m });
                        continue;
                    }

                    const d = extractResult.data;
                    console.log("✅ Data extracted:", d.nameBangla || d.nameEnglish);

                    // Card generate করো
                    console.log("🎨 Generating NID card...");
                    const cardLink = await generateNIDCard(d);
                    console.log("✅ Card generated:", cardLink);

                    // User কে link পাঠাও
                    const name = d.nameBangla || d.nameEnglish || "অজানা";
                    const nid = d.nationalId || "N/A";

                    await sock.sendMessage(from, {
                        text:
                            `✅ *NID কার্ড প্রস্তুত!*\n\n` +
                            `👤 নাম: ${name}\n` +
                            `🪪 NID: ${nid}\n\n` +
                            `🔗 কার্ড দেখতে নিচের লিংকে ক্লিক করুন:\n${cardLink}\n\n` +
                            `📌 লিংক খুললে কার্ড দেখাবে এবং স্বয়ংক্রিয়ভাবে Print dialog আসবে।\n` +
                            `সেখান থেকে *Save as PDF* বা Print করুন।`,
                    }, { quoted: m });

                } catch (err) {
                    console.error("❌ NID processing error:", err.message);
                    await sock.sendMessage(from, {
                        text: `⚠️ সমস্যা হয়েছে:\n${err.message}\n\nআবার চেষ্টা করুন।`,
                    }, { quoted: m });
                }

            } else if (msgType !== "conversation" && msgType !== "extendedTextMessage") {
                // PDF ছাড়া অন্য file পাঠালে
                await sock.sendMessage(from, {
                    text: "📄 অনুগ্রহ করে আপনার NID-এর *PDF ফাইলটি* পাঠান।",
                }, { quoted: m });
            }
        }
    });
}

startBot().catch(err => console.error("Critical Error:", err));
