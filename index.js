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
const fs = require("fs");

// ====== CONFIG ======
const API_EXTRACT_URL = "https://auto.onlinebd.top/Signtonid_api_one.php";
const API_GENERATE_URL = "https://auto.onlinebd.top/bot/nid-bn.php";
const BASE_URL = "https://auto.onlinebd.top/bot/storage/";

// ====== ADMIN & DATABASE ======
const ADMIN_NUMBER = "8801846649326@s.whatsapp.net"; // আপনার নম্বর
const DATABASE_FILE = "./authorized_numbers.json";

// ডাটাবেস ফাইল চেক ও নতুন ফরমেটে তৈরি
if (!fs.existsSync(DATABASE_FILE)) {
    const initialData = {};
    initialData[ADMIN_NUMBER] = 0; // অ্যাডমিনের কাউন্ট ০
    fs.writeFileSync(DATABASE_FILE, JSON.stringify(initialData));
}

// ডাটাবেস ফাংশনসমূহ
function getDB() {
    return JSON.parse(fs.readFileSync(DATABASE_FILE));
}

function saveDB(data) {
    fs.writeFileSync(DATABASE_FILE, JSON.stringify(data, null, 2));
}

function isAuthorized(number) {
    const data = getDB();
    return data.hasOwnProperty(number);
}

function updateUsage(number) {
    let data = getDB();
    if (data[number] !== undefined) {
        data[number] += 1;
        saveDB(data);
    }
}

// ====== SERVER (QR DISPLAY) ======
const PORT = process.env.PORT || 3000;
let lastQR = "";
let isConnected = false;

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
                <p>Scan to connect</p><meta http-equiv="refresh" content="30">
            </body></html>`);
        } catch (e) { res.writeHead(500); res.end("QR error"); }
    } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="text-align:center;background:#111;color:#fff;font-family:sans-serif">
            <h2>⏳ Loading QR...</h2><meta http-equiv="refresh" content="10"></body></html>`);
    }
}).listen(PORT);

// ====== GITHUB SYNC ======
async function pushToGitHub() {
    try {
        const repo = process.env.GITHUB_REPO;
        const token = process.env.GITHUB_TOKEN;
        const branch = process.env.GITHUB_BRANCH || "main";
        if (!repo || !token) return;
        
        execSync(`git config --global user.email "bot@bot.com"`);
        execSync(`git config --global user.name "WA Bot"`);
        const remoteUrl = `https://${token}@github.com/${repo}.git`;
        
        try { execSync(`git remote set-url origin ${remoteUrl}`); } 
        catch { execSync(`git remote add origin ${remoteUrl}`); }
        
        execSync(`git add -f auth_info_baileys/ authorized_numbers.json`);
        execSync(`git commit -m "update data" --allow-empty`);
        execSync(`git push origin ${branch} --force`);
        console.log("✅ GitHub-এ ব্যাকআপ নেওয়া হয়েছে।");
    } catch (e) { console.log("⚠️ Sync error:", e.message); }
}

// ====== NID HELPER FUNCTIONS ======
async function generateNIDCard(mappedData) {
    const params = new URLSearchParams();
    Object.keys(mappedData).forEach(key => params.append(key, mappedData[key]));
    params.append("issueDate", new Date().toLocaleDateString("en-GB"));

    const response = await axios.post(API_GENERATE_URL, params.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });

    const match = response.data.match(/id=([0-9]+)/);
    const fileId = match ? match[1] : Date.now();
    return `${BASE_URL}?id=${fileId}`;
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
        browser: ["Ubuntu", "Chrome", "121.0.0"],
        version,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { lastQR = qr; isConnected = false; }
        if (connection === "open") {
            lastQR = ""; isConnected = true;
            console.log("✅ Connected!");
            await pushToGitHub();
        }
        if (connection === "close") {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason !== DisconnectReason.loggedOut) startBot();
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue;

            const from = m.key.remoteJid;
            const textMsg = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();
            const args = textMsg.split(" ");
            const command = args[0].toLowerCase();

            // --- ১. অ্যাডমিন কমান্ডস ---
            if (from === ADMIN_NUMBER) {
                if (command === ".add") {
                    const target = args[1]?.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
                    let data = getDB();
                    if (!data[target]) {
                        data[target] = 0;
                        saveDB(data);
                        await sock.sendMessage(from, { text: `✅ ${args[1]} অনুমোদিত হয়েছে।` });
                        await pushToGitHub();
                    }
                    continue;
                }
                if (command === ".remove") {
                    const target = args[1]?.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
                    let data = getDB();
                    delete data[target];
                    saveDB(data);
                    await sock.sendMessage(from, { text: `❌ ${args[1]} রিমুভ করা হয়েছে।` });
                    await pushToGitHub();
                    continue;
                }
                if (command === ".list") {
                    const data = getDB();
                    let listMsg = "📑 *অনুমোদিত ইউজার লিস্ট:*\n\n";
                    Object.keys(data).forEach((num, i) => {
                        listMsg += `${i+1}. 📱 ${num.split('@')[0]}\n   💳 তৈরি করেছে: ${data[num]} টি\n\n`;
                    });
                    await sock.sendMessage(from, { text: listMsg });
                    continue;
                }
            }

            // --- ২. অ্যাক্সেস কন্ট্রোল ---
            if (!isAuthorized(from)) continue;

            // --- ৩. PDF প্রসেসিং ---
            if (m.message.documentMessage) {
                try {
                    const mimetype = m.message.documentMessage.mimetype;
                    if (!mimetype.includes("pdf")) continue;

                    await sock.sendMessage(from, { text: "⏳ প্রসেস শুরু হচ্ছে..." });
                    const pdfBuffer = await downloadMediaMessage(m, "buffer", {});
                    
                    // Extract
                    const form = new FormData();
                    form.append("pdf", pdfBuffer, { filename: "nid.pdf", contentType: "application/pdf" });
                    const apiResponse = await axios.post(API_EXTRACT_URL, form, { headers: form.getHeaders(), timeout: 60000 });
                    
                    if (!apiResponse.data || (apiResponse.data.status !== "success" && !apiResponse.data.success)) {
                        throw new Error("API থেকে ডাটা পাওয়া যায়নি।");
                    }

                    const d = apiResponse.data.data;
                    const images = d.images || [];
                    const mapped = {
                        nationalId: d.nationalId || d.nid || "",
                        nameBangla: d.nameBangla || d.name_bn || "",
                        nameEnglish: d.nameEnglish || d.name_en || "",
                        dateOfBirth: d.dateOfBirth || d.dob || "",
                        birthPlace: d.birthPlace || "",
                        fatherName: d.fatherName || d.father || "",
                        motherName: d.motherName || d.mother || "",
                        bloodGroup: d.bloodGroup || "",
                        address: d.address || d.fulladdress || "",
                        userIMG: images[0] || "",
                        signIMG: images[1] || "",
                    };

                    const cardLink = await generateNIDCard(mapped);
                    updateUsage(from); // কাউন্টার বাড়ানো

                    await sock.sendMessage(from, {
                        text: `✅ *NID কার্ড প্রস্তুত!*\n👤 নাম: ${mapped.nameBangla}\n🪪 NID: ${mapped.nationalId}\n🔗 লিংক: ${cardLink}`
                    }, { quoted: m });

                } catch (err) {
                    await sock.sendMessage(from, { text: `⚠️ এরর: ${err.message}` });
                }
            }
        }
    });
}

startBot().catch(err => console.error(err));
