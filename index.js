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

// ====== ADMIN & DATABASE (ID Fixed from Logs) ======
const ADMIN_NUMBER = "241949013491937@lid"; 
const DATABASE_FILE = "./authorized_numbers.json";

function getDB() {
    if (!fs.existsSync(DATABASE_FILE)) {
        const initialData = {};
        initialData[ADMIN_NUMBER] = 0;
        fs.writeFileSync(DATABASE_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }
    return JSON.parse(fs.readFileSync(DATABASE_FILE));
}

function saveDB(data) {
    fs.writeFileSync(DATABASE_FILE, JSON.stringify(data, null, 2));
}

function isAuthorized(number) {
    const data = getDB();
    return data.hasOwnProperty(number) || number === ADMIN_NUMBER;
}

function updateUsage(number) {
    let data = getDB();
    if (data[number] !== undefined) {
        data[number] += 1;
    } else {
        data[number] = 1;
    }
    saveDB(data);
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
                <h2>📱 Scan QR Code</h2><img src="${qrImage}" style="width:280px"/><meta http-equiv="refresh" content="30">
            </body></html>`);
        } catch (e) { res.writeHead(500); res.end("QR error"); }
    } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><body style="text-align:center;background:#111;color:#fff;font-family:sans-serif">
            <h2>⏳ Loading...</h2><meta http-equiv="refresh" content="10"></body></html>`);
    }
}).listen(PORT);

// ====== GITHUB SYNC (Remote Fixed) ======
async function pushToGitHub() {
    try {
        const repo = process.env.GITHUB_REPO;
        const token = process.env.GITHUB_TOKEN;
        const branch = process.env.GITHUB_BRANCH || "main";
        if (!repo || !token) return;

        execSync(`git config --global user.email "bot@bot.com"`);
        execSync(`git config --global user.name "WA Bot"`);
        const remoteUrl = `https://${token}@github.com/${repo}.git`;
        
        try {
            execSync(`git remote add origin ${remoteUrl}`);
        } catch (e) {
            execSync(`git remote set-url origin ${remoteUrl}`);
        }

        execSync(`git add -f auth_info_baileys/ authorized_numbers.json`);
        execSync(`git commit -m "update session/db" --allow-empty`);
        execSync(`git push origin ${branch} --force`);
        console.log("✅ GitHub Sync Done!");
    } catch (e) { console.log("⚠️ Sync Error:", e.message); }
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
            console.log("✅ Connected Successfully!");
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

            console.log(`📩 Message from: ${from} | Text: ${textMsg}`);

            // অ্যাডমিন কমান্ডস
            if (from === ADMIN_NUMBER) {
                if (command === ".ping") {
                    await sock.sendMessage(from, { text: "বট সচল আছে! ✅" });
                    continue;
                }
                if (command === ".add") {
                    let target = args[1];
                    if (!target) continue;
                    if (!target.includes("@")) {
                        target = target.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
                    }
                    let data = getDB();
                    data[target] = 0;
                    saveDB(data);
                    await sock.sendMessage(from, { text: `✅ ${target} এখন অনুমোদিত।` });
                    await pushToGitHub();
                    continue;
                }
                if (command === ".list") {
                    const data = getDB();
                    let listMsg = "📑 *ইউজার লিস্ট:*\n\n";
                    Object.keys(data).forEach((num, i) => {
                        listMsg += `${i+1}. 📱 ${num.split('@')[0]} (কার্ড: ${data[num]})\n`;
                    });
                    await sock.sendMessage(from, { text: listMsg });
                    continue;
                }
                if (command === ".remove") {
                    let target = args[1]?.includes("@") ? args[1] : args[1]?.replace(/[^0-9]/g, "") + "@s.whatsapp.net";
                    let data = getDB();
                    delete data[target];
                    saveDB(data);
                    await sock.sendMessage(from, { text: `❌ ${target} রিমুভ করা হয়েছে।` });
                    await pushToGitHub();
                    continue;
                }
            }

            // অ্যাক্সেস কন্ট্রোল
            if (!isAuthorized(from)) continue;

            // NID প্রসেসিং
            if (m.message.documentMessage) {
                if (!m.message.documentMessage.mimetype.includes("pdf")) continue;
                
                try {
                    await sock.sendMessage(from, { text: "⏳ প্রসেসিং শুরু হচ্ছে..." });
                    const pdfBuffer = await downloadMediaMessage(m, "buffer", {});
                    
                    const form = new FormData();
                    form.append("pdf", pdfBuffer, { filename: "nid.pdf", contentType: "application/pdf" });
                    
                    const apiRes = await axios.post(API_EXTRACT_URL, form, { headers: form.getHeaders(), timeout: 60000 });
                    const d = apiRes.data.data;
                    
                    if (!d) throw new Error("API ডাটা দিতে পারেনি। ফাইলটি সঠিক কি না দেখুন।");

                    const params = new URLSearchParams();
                    const images = d.images || [];
                    const mapped = {
                        nid: d.nationalId || d.nid || "",
                        nameBangla: d.nameBangla || "",
                        nameEnglish: d.nameEnglish || "",
                        dob: d.dateOfBirth || "",
                        birthPlace: d.birthPlace || "",
                        nameFather: d.fatherName || "",
                        nameMother: d.motherName || "",
                        bloodGroup: d.bloodGroup || "",
                        fulladdress: d.address || "",
                        imageUrl12: images[0] || "",
                        imageUrl22: images[1] || "",
                        issueDate: new Date().toLocaleDateString("en-GB")
                    };

                    Object.keys(mapped).forEach(k => params.append(k, mapped[k]));
                    const genRes = await axios.post(API_GENERATE_URL, params.toString());
                    
                    const fileId = genRes.data.match(/id=([0-9]+)/)?.[1] || Date.now();
                    const cardLink = `${BASE_URL}?id=${fileId}`;

                    updateUsage(from);
                    await sock.sendMessage(from, { 
                        text: `✅ *NID কার্ড প্রস্তুত!*\n👤 নাম: ${mapped.nameBangla}\n🪪 NID: ${mapped.nid}\n🔗 লিংক: ${cardLink}` 
                    }, { quoted: m });

                } catch (e) {
                    await sock.sendMessage(from, { text: `⚠️ এরর: ${e.message}` });
                }
            }
        }
    });
}

startBot().catch(e => console.error(e));
