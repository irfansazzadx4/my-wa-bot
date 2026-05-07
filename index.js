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
const API_EXTRACT_URL = "https://server24.kesug.com/Signtonid_api_one.php";
const API_GENERATE_URL = "https://server24.kesug.com/bot/nid-bn.php";
const BASE_URL = "https://server24.kesug.com/bot/storage/";

// ====== SERVER ======
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

// ====== NID DATA EXTRACT ======
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

    console.log("📦 API Raw Response:", JSON.stringify(response.data).substring(0, 500));
    return response.data;
}

// ====== API RESPONSE থেকে DATA MAP করা ======
// API response এ data structure এরকম:
// { success: true, data: { nationalId, nameBangla, nameEnglish, dateOfBirth, ... images: [...] } }
function mapAPIData(apiResponse) {
    if (!apiResponse) throw new Error("Empty API response");

    // status: 'success' অথবা success: true — দুটোই handle করা হচ্ছে
    const isSuccess = apiResponse.status === "success" || apiResponse.success === true;
    if (!isSuccess) {
        throw new Error(apiResponse.message || "API returned error");
    }

    const d = apiResponse.data;
    if (!d) throw new Error("No data in API response");

    // images array থেকে photo ও signature নেওয়া
    const images = d.images || [];
    const userIMG = images[0] || d.userIMG || d.photo || "";
    const signIMG = images[1] || d.signIMG || d.signature || "";

    return {
        nationalId:  d.nationalId  || d.nid       || d.national_id || "",
        nameBangla:  d.nameBangla  || d.name_bn    || d.bangla_name || "",
        nameEnglish: d.nameEnglish || d.name_en    || d.english_name|| "",
        dateOfBirth: d.dateOfBirth || d.dob        || d.date_of_birth || "",
        birthPlace:  d.birthPlace  || d.birth_place|| "",
        fatherName:  d.fatherName  || d.father_name|| d.father      || "",
        motherName:  d.motherName  || d.mother_name|| d.mother      || "",
        bloodGroup:  d.bloodGroup  || d.blood_group|| d.blood       || "",
        address:     d.address     || d.fulladdress|| d.present_address || "",
        userIMG,
        signIMG,
    };
}

// ====== NID CARD GENERATE ======
async function generateNIDCard(mappedData) {
    const params = new URLSearchParams();
    params.append("nid",         mappedData.nationalId);
    params.append("pin",         "");
    params.append("pin_status",  "disabled");
    params.append("nameBangla",  mappedData.nameBangla);
    params.append("nameEnglish", mappedData.nameEnglish);
    params.append("dob",         mappedData.dateOfBirth);
    params.append("birthPlace",  mappedData.birthPlace);
    params.append("nameFather",  mappedData.fatherName);
    params.append("nameMother",  mappedData.motherName);
    params.append("bloodGroup",  mappedData.bloodGroup);
    params.append("fulladdress", mappedData.address);
    params.append("imageUrl12",  mappedData.userIMG);
    params.append("imageUrl22",  mappedData.signIMG);
    params.append("issueDate",   new Date().toLocaleDateString("en-GB"));

    const response = await axios.post(API_GENERATE_URL, params.toString(), {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 30000,
    });

    if (!response.data || response.data.length < 100) {
        throw new Error("Empty HTML response from card generator");
    }

    return BASE_URL + "?id=" + Date.now(); // server এ save হবে
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
        if (qr) { lastQR = qr; isConnected = false; console.log("✅ QR Ready!"); }
        if (connection === "open") {
            lastQR = ""; isConnected = true;
            console.log("✅ WhatsApp Bot Connected!");
            await pushSessionToGitHub();
        }
        if (connection === "close") {
            isConnected = false;
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log("❌ Connection closed. Code:", reason);
            if (reason !== DisconnectReason.loggedOut) startBot();
        }
    });

    // ====== MESSAGE HANDLER ======
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue;

            const from = m.key.remoteJid;
            const msgType = Object.keys(m.message)[0];
            const textMsg = m.message.conversation || m.message.extendedTextMessage?.text || "";

            // .ping কমান্ড
            if (textMsg.trim() === ".ping") {
                await sock.sendMessage(from, { text: "Pong! 🏓 বট সচল আছে।" });
                continue;
            }

            // PDF handle
            if (msgType === "documentMessage") {
                const mimetype = m.message.documentMessage?.mimetype || "";

                if (!mimetype.includes("pdf")) {
                    await sock.sendMessage(from, {
                        text: "❌ শুধুমাত্র PDF ফাইল পাঠান।",
                    }, { quoted: m });
                    continue;
                }

                try {
                    await sock.sendMessage(from, {
                        text: "⏳ আপনার NID প্রক্রিয়া করা হচ্ছে...\nঅনুগ্রহ করে একটু অপেক্ষা করুন।",
                    }, { quoted: m });

                    // PDF download
                    console.log("📥 PDF downloading...");
                    const pdfBuffer = await downloadMediaMessage(m, "buffer", {});
                    console.log("✅ PDF size:", pdfBuffer.length, "bytes");

                    // Extract
                    console.log("🔍 Extracting...");
                    const apiResponse = await extractNIDFromPDF(pdfBuffer);

                    // Map data
                    const mappedData = mapAPIData(apiResponse);
                    console.log("✅ Mapped:", mappedData.nameBangla, mappedData.nationalId);

                    // Generate card
                    console.log("🎨 Generating card...");
                    const cardLink = await generateNIDCard(mappedData);

                    // Reply
                    const name = mappedData.nameBangla || mappedData.nameEnglish || "অজানা";
                    const nid  = mappedData.nationalId || "N/A";

                    await sock.sendMessage(from, {
                        text:
                            `✅ *NID কার্ড প্রস্তুত!*\n\n` +
                            `👤 নাম: ${name}\n` +
                            `🪪 NID: ${nid}\n\n` +
                            `🔗 কার্ড দেখতে লিংকে ক্লিক করুন:\n${cardLink}\n\n` +
                            `📌 লিংক খুললে Print dialog আসবে।\n` +
                            `*Save as PDF* বা Print করুন।`,
                    }, { quoted: m });

                } catch (err) {
                    console.error("❌ Error:", err.message);
                    // Debug: full error log
                    console.error("Full error:", err);
                    await sock.sendMessage(from, {
                        text: `⚠️ সমস্যা হয়েছে:\n${err.message}\n\nআবার চেষ্টা করুন।`,
                    }, { quoted: m });
                }

            } else if (msgType !== "conversation" && msgType !== "extendedTextMessage") {
                await sock.sendMessage(from, {
                    text: "📄 অনুগ্রহ করে আপনার NID-এর *PDF ফাইলটি* পাঠান।",
                }, { quoted: m });
            }
        }
    });
}

startBot().catch(err => console.error("Critical Error:", err));
