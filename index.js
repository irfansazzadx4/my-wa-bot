console.log("🚀 BOT STARTING...");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const pino         = require("pino");
const { Boom }     = require("@hapi/boom");
const http         = require("http");
const qrcode       = require("qrcode");
const { execSync } = require("child_process");
const FormData     = require("form-data");
const axios        = require("axios");
const fs           = require("fs");
const path         = require("path");
const crypto       = require("crypto");

// ============================================================
//  CONFIG
// ============================================================
const CONFIG = {
    API_EXTRACT_URL : "https://auto.onlinebd.top/Signtonid_api_one.php",
    API_GENERATE_URL: "https://auto.onlinebd.top/bot/nid-bn.php",
    BASE_URL        : "https://auto.onlinebd.top/bot/storage/",
    STORAGE_DIR     : "./storage",
    USERS_FILE      : "./users.json",
    STATS_FILE      : "./stats.json",
    SETTINGS_FILE   : "./settings.json",
    PORT            : process.env.PORT || 3000,
    ADMIN_PASS      : process.env.ADMIN_PASS || "admin123",
    PDF_API_URL     : process.env.PDF_API_URL || "",
    PDF_API_SECRET  : process.env.PDF_API_SECRET || "nid_pdf_secret_2025",
    SELF_URL        : process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || "",
};

// ============================================================
//  HELPERS
// ============================================================
function loadJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { return fallback; }
}
function saveJSON(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
function getUsers()      { return loadJSON(CONFIG.USERS_FILE,   []); }
function saveUsers(u)    { saveJSON(CONFIG.USERS_FILE, u); }
function getStats()      { return loadJSON(CONFIG.STATS_FILE,   {}); }
function getSettings()   { return loadJSON(CONFIG.SETTINGS_FILE, { cardPrice: 0 }); }
function saveSettings(s) { saveJSON(CONFIG.SETTINGS_FILE, s); }

function normalizeNumber(num) {
    let n = String(num).replace(/\D/g, "");
    if (n.length === 11 && n.startsWith("01")) n = "880" + n.slice(1);
    return n;
}

function isAllowed(number) {
    const users = getUsers();
    if (users.length === 0) return false;
    const norm = normalizeNumber(number);
    const u = users.find(x => normalizeNumber(x.number) === norm);
    return u && (u.active !== false);
}

function getUserBalance(number) {
    const norm = normalizeNumber(number);
    const u    = getUsers().find(x => normalizeNumber(x.number) === norm);
    return u ? (u.balance ?? 0) : 0;
}

// Balance deduct — false হলে অপর্যাপ্ত
function deductBalance(number) {
    const settings = getSettings();
    const price    = settings.cardPrice || 0;
    if (price <= 0) return true;
    const users = getUsers();
    const norm  = normalizeNumber(number);
    const u     = users.find(x => normalizeNumber(x.number) === norm);
    if (!u) return false;
    const bal = u.balance ?? 0;
    if (bal < price) return false;
    u.balance = Math.round((bal - price) * 100) / 100;
    saveUsers(users);
    return true;
}

function recordStat(number, name) {
    const stats = getStats();
    if (!stats[number]) stats[number] = { name, count: 0, lastUsed: "" };
    stats[number].count++;
    stats[number].lastUsed = new Date().toLocaleString("bn-BD");
    stats[number].name = name || stats[number].name;
    saveJSON(CONFIG.STATS_FILE, stats);
    pushDataToGitHub().catch(() => {});
}

// ============================================================
//  QR / CONNECTION STATE
// ============================================================
let lastQR      = "";
let isConnected = false;
const adminSessions = new Set();

// ============================================================
//  HTTP SERVER
// ============================================================
http.createServer(async (req, res) => {
    const urlObj  = new URL(req.url, `http://localhost`);
    const reqPath = urlObj.pathname;

    if (reqPath === "/test") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("OK BOT RUNNING");
    }
    if (reqPath.startsWith("/storage/")) {
        const file = "." + reqPath;
        if (fs.existsSync(file)) {
            const ct = file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
            res.writeHead(200, { "Content-Type": ct });
            return fs.createReadStream(file).pipe(res);
        }
        res.writeHead(404); return res.end("Not found");
    }
    if (reqPath === "/admin" || reqPath.startsWith("/admin")) {
        return handleAdmin(req, res, urlObj);
    }
    if (isConnected) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(htmlPage("✅ Bot Connected",
            `<div class="connected">✅ WhatsApp Bot সংযুক্ত!</div>
             <a href="/admin" class="btn">Admin Panel →</a>`));
    }
    if (lastQR) {
        try {
            const qrImg = await qrcode.toDataURL(lastQR);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            return res.end(htmlPage("QR Code",
                `<h2>📱 WhatsApp QR Scan করুন</h2>
                 <img src="${qrImg}" style="width:260px;border:4px solid #25D366;border-radius:12px">
                 <p>WhatsApp → Linked Devices → Link a Device</p>
                 <meta http-equiv="refresh" content="30">`));
        } catch { res.writeHead(500); return res.end("QR error"); }
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlPage("Loading", `<h2>⏳ QR লোড হচ্ছে...</h2><meta http-equiv="refresh" content="8">`));

}).listen(CONFIG.PORT, () => {
    console.log(`✅ Server: http://localhost:${CONFIG.PORT}`);
    startSelfPing();
});

function startSelfPing() {
    if (!CONFIG.SELF_URL) return;
    setInterval(async () => {
        try { await axios.get(CONFIG.SELF_URL + "/test", { timeout: 10000 }); }
        catch (e) { console.log("⚠️ Self-ping:", e.message); }
    }, 10 * 60 * 1000);
}

// ============================================================
//  ADMIN PANEL
// ============================================================
async function handleAdmin(req, res, urlObj) {
    const cookies = parseCookies(req.headers.cookie || "");
    const authed  = cookies.admin_sess && adminSessions.has(cookies.admin_sess);

    if (req.method === "POST") {
        const body   = await readBody(req);
        const params = new URLSearchParams(body);
        const action = params.get("action");

        if (action === "login") {
            if (params.get("pass") === CONFIG.ADMIN_PASS) {
                const sess = crypto.randomBytes(16).toString("hex");
                adminSessions.add(sess);
                res.writeHead(302, { "Set-Cookie": `admin_sess=${sess}; Path=/; HttpOnly`, "Location": "/admin" });
            } else {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(adminLogin("❌ ভুল পাসওয়ার্ড!"));
            }
            return res.end && res.end();
        }

        if (!authed) { res.writeHead(302, { Location: "/admin" }); return res.end(); }

        if (action === "add") {
            const number  = normalizeNumber(params.get("number") || "");
            const name    = (params.get("name") || "").trim();
            const balance = parseFloat(params.get("balance") || "0") || 0;
            if (number) {
                const users = getUsers();
                if (!users.find(u => normalizeNumber(u.number) === number)) {
                    users.push({ number, name, active: true, balance, added: new Date().toLocaleString("bn-BD") });
                    saveUsers(users);
                }
            }
        } else if (action === "recharge") {
            const number = params.get("number");
            const amount = parseFloat(params.get("amount") || "0") || 0;
            if (amount > 0) {
                const users = getUsers();
                const u     = users.find(x => x.number === number);
                if (u) { u.balance = Math.round(((u.balance ?? 0) + amount) * 100) / 100; saveUsers(users); }
            }
        } else if (action === "set_price") {
            const price    = parseFloat(params.get("price") || "0") || 0;
            const settings = getSettings();
            settings.cardPrice = price;
            saveSettings(settings);
        } else if (action === "toggle") {
            const users = getUsers();
            const u = users.find(x => x.number === params.get("number"));
            if (u) u.active = !u.active;
            saveUsers(users);
        } else if (action === "delete") {
            saveUsers(getUsers().filter(u => u.number !== params.get("number")));
        } else if (action === "logout") {
            adminSessions.delete(cookies.admin_sess);
            res.writeHead(302, { "Set-Cookie": "admin_sess=; Path=/; Max-Age=0", "Location": "/admin" });
            return res.end();
        } else if (action === "backup_now") {
            await pushDataToGitHub().catch(e => console.log("Backup:", e.message));
        }

        res.writeHead(302, { Location: "/admin" }); return res.end();
    }

    if (!authed) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(adminLogin(""));
    }

    const users      = getUsers();
    const stats      = getStats();
    const settings   = getSettings();
    const totalCards = Object.values(stats).reduce((s, x) => s + (x.count || 0), 0);
    const activeUsers= users.filter(u => u.active !== false).length;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(adminDashboard(users, stats, totalCards, activeUsers, settings));
}

// ============================================================
//  GITHUB — Session push
// ============================================================
async function pushSessionToGitHub() {
    try {
        const repo   = process.env.GITHUB_REPO;
        const token  = process.env.GITHUB_TOKEN;
        const branch = process.env.GITHUB_BRANCH || "main";
        if (!repo || !token) return;
        execSync(`git config --global user.email "bot@bot.com"`);
        execSync(`git config --global user.name "WA Bot"`);
        const remote = `https://${token}@github.com/${repo}.git`;
        try { execSync(`git remote set-url origin ${remote}`); }
        catch { execSync(`git remote add origin ${remote}`); }
        execSync(`git add -f auth_info_baileys/`);
        execSync(`git commit -m "session update" --allow-empty`);
        execSync(`git push origin ${branch} --force`);
        console.log("✅ Session saved to GitHub");
    } catch (e) { console.log("⚠️ GitHub session push:", e.message); }
}

// ============================================================
//  GITHUB — Data backup (users + stats + settings)
//  প্রতিটি card generate এর পরে auto backup হয়
//  Deploy এর পরে বা QR re-login করলেও data টিকে থাকে
// ============================================================
async function pushDataToGitHub() {
    try {
        const repo   = process.env.GITHUB_REPO;
        const token  = process.env.GITHUB_TOKEN;
        const branch = process.env.GITHUB_BRANCH || "main";
        if (!repo || !token) return;
        execSync(`git config --global user.email "bot@bot.com"`);
        execSync(`git config --global user.name "WA Bot"`);
        const remote = `https://${token}@github.com/${repo}.git`;
        try { execSync(`git remote set-url origin ${remote}`); }
        catch { execSync(`git remote add origin ${remote}`); }
        const files = [CONFIG.USERS_FILE, CONFIG.STATS_FILE, CONFIG.SETTINGS_FILE]
            .filter(f => fs.existsSync(f)).join(" ");
        if (!files) return;
        execSync(`git add -f ${files}`);
        execSync(`git commit -m "data-backup" --allow-empty`);
        execSync(`git push origin ${branch} --force`);
        console.log("✅ Data backup done");
    } catch (e) { console.log("⚠️ Data backup:", e.message); }
}

// ============================================================
//  GITHUB — Data restore on startup
//  Deploy এর পরে GitHub থেকে পুরানো data ফিরিয়ে আনে
// ============================================================
async function restoreDataFromGitHub() {
    try {
        const repo   = process.env.GITHUB_REPO;
        const token  = process.env.GITHUB_TOKEN;
        const branch = process.env.GITHUB_BRANCH || "main";
        if (!repo || !token) return;
        const missing = [CONFIG.USERS_FILE, CONFIG.STATS_FILE, CONFIG.SETTINGS_FILE]
            .some(f => !fs.existsSync(f));
        if (!missing) return; // সব আছে, restore দরকার নেই
        const remote = `https://${token}@github.com/${repo}.git`;
        execSync(`git config --global user.email "bot@bot.com"`);
        execSync(`git config --global user.name "WA Bot"`);
        try { execSync(`git remote set-url origin ${remote}`); }
        catch { execSync(`git remote add origin ${remote}`); }
        execSync(`git fetch origin ${branch} --depth=1`);
        try {
            execSync(`git checkout origin/${branch} -- users.json stats.json settings.json`);
            console.log("✅ Data restored from GitHub");
        } catch { console.log("ℹ️ No data files in GitHub yet — starting fresh"); }
    } catch (e) { console.log("⚠️ Data restore:", e.message); }
}

// ============================================================
//  NID EXTRACT
// ============================================================
async function extractNIDFromPDF(pdfBuffer) {
    const form = new FormData();
    form.append("pdf", pdfBuffer, { filename: "nid.pdf", contentType: "application/pdf" });
    const res = await axios.post(CONFIG.API_EXTRACT_URL, form, {
        headers: form.getHeaders(), timeout: 60000,
    });
    console.log("📦 Extract:", JSON.stringify(res.data).substring(0, 300));
    return res.data;
}

function mapAPIData(api) {
    if (!api) throw new Error("Empty API response");
    const ok = api.status === "success" || api.success === true || api.status === 200;
    if (!ok) throw new Error(api.message || api.error || "API error");
    const d = api.data || api;
    if (!d) throw new Error("No data in response");
    const images = Array.isArray(d.images) ? d.images : [];
    return {
        nationalId : d.nationalId  || d.nid        || "",
        nameBangla : d.nameBangla  || d.name_bn     || "",
        nameEnglish: d.nameEnglish || d.name_en     || "",
        dateOfBirth: d.dateOfBirth || d.dob         || "",
        birthPlace : d.birthPlace  || d.birth_place || "",
        fatherName : d.fatherName  || d.father_name || "",
        motherName : d.motherName  || d.mother_name || "",
        bloodGroup : d.bloodGroup  || d.blood_group || "",
        address    : d.address     || d.fulladdress || "",
        userIMG    : images[0]     || d.userIMG     || d.photo || "",
        signIMG    : images[1]     || d.signIMG     || d.sign  || "",
    };
}

// ============================================================
//  HTML SAVE — clean card (কোনো banner/text নেই)
//  User চাইলে link থেকে browser এ খুলে print করতে পারবে
// ============================================================
async function buildAndSaveHTML(mappedData) {
    if (!fs.existsSync(CONFIG.STORAGE_DIR)) fs.mkdirSync(CONFIG.STORAGE_DIR);

    const params = new URLSearchParams({
        nid        : mappedData.nationalId,
        pin        : "",
        pin_status : "disabled",
        nameBangla : mappedData.nameBangla,
        nameEnglish: mappedData.nameEnglish,
        dob        : mappedData.dateOfBirth,
        birthPlace : mappedData.birthPlace,
        nameFather : mappedData.fatherName,
        nameMother : mappedData.motherName,
        bloodGroup : mappedData.bloodGroup,
        fulladdress: mappedData.address,
        imageUrl12 : mappedData.userIMG,
        imageUrl22 : mappedData.signIMG,
        issueDate  : new Date().toLocaleDateString("en-GB"),
    });

    const htmlRes = await axios.post(
        CONFIG.API_GENERATE_URL,
        params.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 30000, responseType: "text" }
    );

    let html = htmlRes.data;
    if (!html || html.length < 200) throw new Error("Empty HTML from nid-bn.php");

    html = fixRelativePaths(html);
    // window.print() রেখে দাও — user browser এ print করতে পারবে
    // html = html.replace(/window\.print\(\);?/g, "// print removed");

    const filename = `${Date.now()}_card.html`;
    const filepath = path.join(CONFIG.STORAGE_DIR, filename);
    fs.writeFileSync(filepath, html);

    const serveBase = (CONFIG.SELF_URL || '').replace(/\/$/, '') + '/storage/';
    return serveBase ? serveBase + filename : CONFIG.BASE_URL + filename;
}

// ============================================================
//  PDF GENERATE
// ============================================================
async function generatePDFFromMapped(mappedData) {
    const params = new URLSearchParams({
        nid        : mappedData.nationalId,
        pin        : "",
        pin_status : "disabled",
        nameBangla : mappedData.nameBangla,
        nameEnglish: mappedData.nameEnglish,
        dob        : mappedData.dateOfBirth,
        birthPlace : mappedData.birthPlace,
        nameFather : mappedData.fatherName,
        nameMother : mappedData.motherName,
        bloodGroup : mappedData.bloodGroup,
        fulladdress: mappedData.address,
        imageUrl12 : mappedData.userIMG,
        imageUrl22 : mappedData.signIMG,
        issueDate  : new Date().toLocaleDateString("en-GB"),
    });

    const htmlRes = await axios.post(
        CONFIG.API_GENERATE_URL,
        params.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 30000, responseType: "text" }
    );

    let html = htmlRes.data;
    if (!html || html.length < 200) throw new Error("Empty HTML from nid-bn.php");

    html = fixRelativePaths(html);
    html = await embedFontsInHTML(html);
    console.log(`✅ Fonts embedded, HTML: ${html.length} chars`);

    if (!CONFIG.PDF_API_URL) throw new Error("PDF_API_URL not set");

    const pdfRes = await axios.post(
        CONFIG.PDF_API_URL + "/pdf",
        { secret: CONFIG.PDF_API_SECRET, html },
        { headers: { "Content-Type": "application/json" }, timeout: 120000 }
    );

    if (!pdfRes.data?.success) throw new Error("PDF API: " + (pdfRes.data?.error || "unknown"));
    const pdfBuffer = Buffer.from(pdfRes.data.pdf, "base64");
    console.log(`✅ PDF: ${pdfBuffer.length} bytes`);
    return pdfBuffer;
}

// ============================================================
//  MAIN BOT
// ============================================================
async function startBot() {
    await restoreDataFromGitHub();

    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })) },
        printQRInTerminal     : false,
        logger                : pino({ level: "fatal" }),
        browser               : ["Chrome (Linux)", "Chrome", "121.0.0"],
        version,
        connectTimeoutMs      : 60000,
        defaultQueryTimeoutMs : undefined,
        retryRequestDelayMs   : 2000,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { lastQR = qr; isConnected = false; console.log("✅ QR Ready"); }
        if (connection === "open") {
            lastQR = ""; isConnected = true;
            console.log("✅ WhatsApp Connected!");
            await pushSessionToGitHub();
            await pushDataToGitHub().catch(() => {});
        }
        if (connection === "close") {
            isConnected = false;
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log("❌ Disconnected. Code:", code);
            if (code === DisconnectReason.loggedOut) {
                try { fs.rmSync("auth_info_baileys", { recursive: true, force: true }); } catch {}
            }
            setTimeout(startBot, code === 408 ? 5000 : 3000);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const m of messages) {
            try { await handleMessage(sock, m); }
            catch (err) { console.error("❌ handleMessage:", err.message); }
        }
    });
}

// ============================================================
//  MESSAGE HANDLER
// ============================================================
async function handleMessage(sock, m) {
    const from = m.key?.remoteJid || "";
    if (!m.message || m.key.fromMe) return;
    if (from.endsWith("@g.us")) return;

    const number  = from.replace("@s.whatsapp.net", "").replace("@lid", "");
    const msg     = m.message?.documentWithCaptionMessage?.message
                 || m.message?.viewOnceMessage?.message
                 || m.message;
    const msgType = msg ? Object.keys(msg)[0] : "";
    const text    = (msg?.conversation || msg?.extendedTextMessage?.text || "").trim();

    console.log(`📩 from=${number} type=${msgType} text="${text}"`);

    // ── .ping ──
    if (text === ".ping") {
        await sock.sendMessage(from, { text: "🏓 Pong! Bot সচল আছে।" });
        return;
    }

    // ── .status ──
    if (text === ".status") {
        const settings = getSettings();
        const price    = settings.cardPrice || 0;
        if (isAllowed(number)) {
            const bal     = getUserBalance(number);
            const balText = price > 0
                ? `\n\n💰 আপনার Balance: *${bal} টাকা*\n💳 প্রতি কার্ড: *${price} টাকা*`
                : "";
            await sock.sendMessage(from, {
                text: `✅ আপনি অনুমোদিত। NID PDF পাঠান।${balText}`
            });
        } else {
            await sock.sendMessage(from, { text: "⛔ আপনি অনুমোদিত নন।\nঅ্যাডমিনের সাথে যোগাযোগ করুন।" });
        }
        return;
    }

    // ── Non-PDF message ──
    const docMsg = msg?.documentMessage;
    if (!docMsg) {
        if (msgType === "conversation" || msgType === "extendedTextMessage") {
            await sock.sendMessage(from, {
                text: "📄 অনুগ্রহ করে আপনার NID-এর *PDF ফাইলটি* পাঠান।"
            }, { quoted: m });
        }
        return;
    }

    if (!docMsg.mimetype?.includes("pdf")) {
        await sock.sendMessage(from, { text: "❌ শুধুমাত্র PDF ফাইল পাঠান।" }, { quoted: m });
        return;
    }

    // ── Permission check ──
    if (!isAllowed(number)) {
        await sock.sendMessage(from, {
            text: "⛔ আপনার নম্বরটি অনুমোদিত নয়।\nঅ্যাডমিনের সাথে যোগাযোগ করুন।"
        }, { quoted: m });
        return;
    }

    // ── Balance check ──
    const settings = getSettings();
    const price    = settings.cardPrice || 0;
    if (price > 0) {
        const bal = getUserBalance(number);
        if (bal < price) {
            await sock.sendMessage(from, {
                text:
                    `⚠️ *Balance অপর্যাপ্ত!*\n\n` +
                    `💰 আপনার Balance: *${bal} টাকা*\n` +
                    `💳 কার্ড তৈরিতে লাগে: *${price} টাকা*\n\n` +
                    `Balance Recharge করতে অ্যাডমিনের সাথে যোগাযোগ করুন।`
            }, { quoted: m });
            return;
        }
    }

    // ── Auto PDF Process ──
    await sock.sendMessage(from, {
        text: "⏳ NID Card তৈরি হচ্ছে... একটু অপেক্ষা করুন।"
    }, { quoted: m });

    try {
        const dlMsg  = { ...m, message: msg };
        const pdfBuf = await downloadMediaMessage(dlMsg, "buffer", {});
        if (!pdfBuf || pdfBuf.length < 100) throw new Error("PDF download failed or empty");
        console.log(`✅ PDF: ${pdfBuf.length} bytes from ${number}`);

        const apiRes = await extractNIDFromPDF(pdfBuf);
        const mapped = mapAPIData(apiRes);
        if (!mapped.nationalId && !mapped.nameBangla) throw new Error("NID তথ্য বের করা যায়নি।");
        console.log(`✅ Extracted: ${mapped.nameBangla} | ${mapped.nationalId}`);

        // Balance deduct
        deductBalance(number);

        // PDF ও HTML parallel এ বানাও
        const [outPdf, htmlUrl] = await Promise.allSettled([
            generatePDFFromMapped(mapped),
            buildAndSaveHTML(mapped),
        ]).then(([pdfResult, htmlResult]) => [
            pdfResult.status === "fulfilled" ? pdfResult.value : null,
            htmlResult.status === "fulfilled" ? htmlResult.value : "",
        ]);

        if (!outPdf) throw new Error("PDF তৈরি করা সম্ভব হয়নি।");

        // Stats record + auto GitHub backup
        recordStat(number, mapped.nameBangla || mapped.nameEnglish);

        const name    = mapped.nameBangla || mapped.nameEnglish || "অজানা";
        const nid     = mapped.nationalId || "N/A";
        const pdfName = `NID_${nid}.pdf`;

        let balMsg  = "";
        if (price > 0) {
            balMsg = `\n💰 বাকি Balance: *${getUserBalance(number)} টাকা*`;
        }
        let linkMsg = htmlUrl
            ? `\n\n🖨️ Browser থেকে Print করতে:\n${htmlUrl}`
            : "";

        await sock.sendMessage(from, {
            document : outPdf,
            mimetype : "application/pdf",
            fileName : pdfName,
            caption  :
                `✅ *NID কার্ড প্রস্তুত!*\n\n` +
                `👤 নাম: ${name}\n` +
                `🪪 NID: ${nid}\n` +
                `📅 DOB: ${mapped.dateOfBirth}` +
                balMsg + linkMsg,
        }, { quoted: m });

        console.log(`✅ PDF sent to ${number}`);

    } catch (err) {
        console.error("❌ Process error:", err.message);
        await sock.sendMessage(from, {
            text: `⚠️ সমস্যা হয়েছে:\n${err.message}\n\nআবার চেষ্টা করুন।`
        }, { quoted: m });
    }
}

startBot().catch(err => console.error("Critical:", err));

// ============================================================
//  HTML TEMPLATES
// ============================================================
function htmlPage(title, body) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0f14;color:#e8eaf0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
.connected{font-size:1.4rem;margin-bottom:20px}.btn{display:inline-block;padding:10px 24px;background:#00e5a0;color:#0d1a12;border-radius:8px;text-decoration:none;font-weight:700;margin-top:12px}
h2{margin-bottom:12px}p{color:#6b7894;margin-top:8px;font-size:.9rem}img{margin:12px auto;display:block}</style></head>
<body><div>${body}</div></body></html>`;
}

function adminLogin(error) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin Login</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0f14;color:#e8eaf0;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#161b24;border:1px solid #2a3347;border-radius:16px;padding:44px 38px;width:340px;box-shadow:0 0 50px rgba(0,229,160,.07)}
.icon{width:52px;height:52px;background:linear-gradient(135deg,#00e5a0,#0084ff);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;margin:0 auto 18px}
h2{text-align:center;margin-bottom:6px;font-size:1.1rem}p{text-align:center;color:#6b7894;font-size:.78rem;margin-bottom:26px}
label{display:block;font-size:.72rem;color:#6b7894;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px}
input{width:100%;padding:11px 14px;background:#1e2535;border:1px solid #2a3347;border-radius:9px;color:#e8eaf0;font-size:.9rem;outline:none;margin-bottom:16px}
input:focus{border-color:#00e5a0}button{width:100%;padding:12px;background:linear-gradient(135deg,#00e5a0,#00c080);border:none;border-radius:9px;color:#0d1a12;font-weight:700;font-size:.95rem;cursor:pointer}
.err{background:rgba(255,69,96,.1);border:1px solid rgba(255,69,96,.3);color:#ff4560;padding:9px 13px;border-radius:8px;font-size:.82rem;margin-bottom:14px;text-align:center}</style></head>
<body><div class="box"><div class="icon">🤖</div><h2>Bot Admin Panel</h2><p>WhatsApp NID Card Bot</p>
${error ? `<div class="err">${error}</div>` : ""}
<form method="POST" action="/admin"><input type="hidden" name="action" value="login">
<label>Password</label><input type="password" name="pass" placeholder="••••••••" autofocus>
<button type="submit">Login →</button></form></div></body></html>`;
}

function adminDashboard(users, stats, totalCards, activeUsers, settings) {
    const price = settings.cardPrice || 0;

    const statsRows = Object.entries(stats).map(([num, s]) =>
        `<tr><td class="num">${num}</td><td>${s.name||'—'}</td><td class="cnt">${s.count}</td><td class="dt">${s.lastUsed}</td></tr>`
    ).join("") || `<tr><td colspan="4" class="empty">এখনো কেউ ব্যবহার করেনি</td></tr>`;

    const userRows = users.map(u => {
        const active = u.active !== false;
        const bal    = u.balance ?? 0;
        return `<tr>
        <td class="num">${u.number}</td>
        <td>${u.name||'—'}</td>
        <td><span class="badge ${active?'on':'off'}">${active?'Active':'Inactive'}</span></td>
        ${price > 0 ? `<td class="bal">${bal} ৳</td>` : ''}
        <td class="dt">${u.added||''}</td>
        <td>
          ${price > 0 ? `
          <form method="POST" style="display:inline">
            <input type="hidden" name="action" value="recharge">
            <input type="hidden" name="number" value="${u.number}">
            <input type="number" name="amount" placeholder="টাকা" min="1" step="0.5"
              style="width:65px;padding:3px 6px;background:#1e2535;border:1px solid #2a3347;border-radius:5px;color:#e8eaf0;font-size:.75rem;margin-right:3px">
            <button class="btn-sm ok" type="submit">Recharge</button>
          </form>` : ''}
          <form method="POST" style="display:inline">
            <input type="hidden" name="action" value="toggle">
            <input type="hidden" name="number" value="${u.number}">
            <button class="btn-sm ${active?'warn':'ok'}">${active?'Deactivate':'Activate'}</button>
          </form>
          <form method="POST" style="display:inline" onsubmit="return confirm('মুছবেন?')">
            <input type="hidden" name="action" value="delete">
            <input type="hidden" name="number" value="${u.number}">
            <button class="btn-sm danger">Delete</button>
          </form>
        </td></tr>`;
    }).join("") || `<tr><td colspan="${price>0?6:5}" class="empty">কোনো user নেই</td></tr>`;

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin Panel</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0f14;color:#e8eaf0;font-family:'Segoe UI',sans-serif;min-height:100vh}
.topbar{background:#161b24;border-bottom:1px solid #2a3347;padding:13px 24px;display:flex;align-items:center;justify-content:space-between}
.t-left{display:flex;align-items:center;gap:11px}
.t-logo{width:34px;height:34px;background:linear-gradient(135deg,#00e5a0,#0084ff);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:17px}
.t-title{font-size:.95rem;font-weight:700}.t-sub{font-size:.7rem;color:#6b7894}
.btn-out{background:transparent;border:1px solid #2a3347;color:#6b7894;padding:6px 14px;border-radius:8px;font-size:.76rem;cursor:pointer}
.btn-out:hover{border-color:#ff4560;color:#ff4560}
.btn-backup{background:rgba(0,132,255,.12);border:1px solid rgba(0,132,255,.35);color:#0084ff;padding:6px 14px;border-radius:8px;font-size:.76rem;cursor:pointer;font-family:inherit}
.btn-backup:hover{background:rgba(0,132,255,.22)}
.topbar-right{display:flex;gap:8px;align-items:center}
.wrap{max-width:980px;margin:0 auto;padding:24px 18px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin-bottom:24px}
.sc{background:#161b24;border:1px solid #2a3347;border-radius:10px;padding:16px 18px}
.sc-label{font-size:.7rem;color:#6b7894;letter-spacing:1px;text-transform:uppercase;margin-bottom:7px}
.sc-val{font-size:2rem;font-weight:700}.green{color:#00e5a0}.blue{color:#0084ff}.gold{color:#ffd700}
.card{background:#161b24;border:1px solid #2a3347;border-radius:10px;overflow:hidden;margin-bottom:22px}
.card-head{padding:14px 18px;border-bottom:1px solid #2a3347;font-size:.8rem;color:#00e5a0;letter-spacing:1px;text-transform:uppercase}
.price-form{padding:14px 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-bottom:1px solid #2a3347}
.price-form label{font-size:.82rem;color:#6b7894}
.price-form input[type=number]{width:110px;padding:8px 12px;background:#1e2535;border:1px solid #2a3347;border-radius:8px;color:#e8eaf0;font-size:.9rem;outline:none}
.price-form input:focus{border-color:#ffd700}
.btn-price{padding:8px 18px;background:#ffd700;border:none;border-radius:8px;color:#0d0f14;font-weight:700;font-size:.84rem;cursor:pointer}
.price-note{font-size:.74rem;color:#6b7894}
.add-form{padding:16px 18px;display:flex;gap:9px;flex-wrap:wrap}
.add-form input{flex:1;min-width:130px;padding:9px 13px;background:#1e2535;border:1px solid #2a3347;border-radius:8px;color:#e8eaf0;font-size:.86rem;outline:none}
.add-form input:focus{border-color:#00e5a0}
.btn-add{padding:9px 20px;background:#00e5a0;border:none;border-radius:8px;color:#0d1a12;font-weight:700;font-size:.86rem;cursor:pointer}
table{width:100%;border-collapse:collapse}
thead th{padding:10px 15px;text-align:left;font-size:.7rem;color:#6b7894;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid #2a3347}
tbody td{padding:10px 15px;font-size:.84rem;border-bottom:1px solid rgba(42,51,71,.5);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}tbody tr:hover{background:rgba(255,255,255,.02)}
.num{color:#0084ff;font-family:monospace}.cnt{color:#00e5a0;font-weight:700}.dt{color:#6b7894;font-size:.76rem}
.bal{color:#ffd700;font-weight:700}
.badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:.7rem;font-weight:700}
.on{background:rgba(0,229,160,.12);color:#00e5a0}.off{background:rgba(255,69,96,.1);color:#ff4560}
.empty{text-align:center;color:#6b7894;padding:30px}
.btn-sm{padding:4px 10px;border-radius:6px;font-size:.74rem;font-family:inherit;cursor:pointer;border:1px solid;font-weight:600;margin-right:4px}
.btn-sm.warn{border-color:rgba(255,165,0,.4);color:#ffa500;background:rgba(255,165,0,.08)}
.btn-sm.ok{border-color:rgba(0,229,160,.4);color:#00e5a0;background:rgba(0,229,160,.08)}
.btn-sm.danger{border-color:rgba(255,69,96,.3);color:#ff4560;background:rgba(255,69,96,.06)}
@media(max-width:660px){.stats{grid-template-columns:1fr 1fr}}</style></head>
<body>
<div class="topbar">
  <div class="t-left">
    <div class="t-logo">🤖</div>
    <div><div class="t-title">Bot Admin Panel</div><div class="t-sub">WhatsApp NID Card Bot</div></div>
  </div>
  <div class="topbar-right">
    <form method="POST">
      <input type="hidden" name="action" value="backup_now">
      <button class="btn-backup" type="submit">☁️ Backup Now</button>
    </form>
    <form method="POST">
      <input type="hidden" name="action" value="logout">
      <button class="btn-out">Logout</button>
    </form>
  </div>
</div>

<div class="wrap">
  <div class="stats">
    <div class="sc"><div class="sc-label">মোট Users</div><div class="sc-val blue">${users.length}</div></div>
    <div class="sc"><div class="sc-label">Active</div><div class="sc-val green">${activeUsers}</div></div>
    <div class="sc"><div class="sc-label">মোট Cards</div><div class="sc-val green">${totalCards}</div></div>
    <div class="sc"><div class="sc-label">কার্ড মূল্য</div><div class="sc-val gold">${price > 0 ? price + ' ৳' : 'Free'}</div></div>
  </div>

  <div class="card">
    <div class="card-head">💳 প্রতি কার্ডের মূল্য নির্ধারণ</div>
    <form method="POST" class="price-form">
      <input type="hidden" name="action" value="set_price">
      <label>মূল্য:</label>
      <input type="number" name="price" value="${price}" min="0" step="0.5" placeholder="0">
      <button type="submit" class="btn-price">Set Price</button>
      <span class="price-note">0 দিলে সবার জন্য ফ্রি</span>
    </form>
  </div>

  <div class="card">
    <div class="card-head">➕ নতুন Number যোগ করুন</div>
    <form method="POST" class="add-form">
      <input type="hidden" name="action" value="add">
      <input type="text" name="number" placeholder="8801XXXXXXXXX (দেশ কোড সহ)" required>
      <input type="text" name="name" placeholder="নাম (ঐচ্ছিক)">
      ${price > 0 ? `<input type="number" name="balance" placeholder="প্রাথমিক Balance (৳)" min="0" step="0.5">` : `<input type="hidden" name="balance" value="0">`}
      <button type="submit" class="btn-add">যোগ করুন</button>
    </form>
  </div>

  <div class="card">
    <div class="card-head">📋 অনুমোদিত Numbers</div>
    <table>
      <thead><tr>
        <th>Number</th><th>নাম</th><th>Status</th>
        ${price > 0 ? '<th>Balance</th>' : ''}
        <th>যোগের তারিখ</th><th>Action</th>
      </tr></thead>
      <tbody>${userRows}</tbody>
    </table>
  </div>

  <div class="card">
    <div class="card-head">📊 Card Generation Statistics</div>
    <table>
      <thead><tr><th>Number</th><th>নাম</th><th>Cards</th><th>শেষ ব্যবহার</th></tr></thead>
      <tbody>${statsRows}</tbody>
    </table>
  </div>
</div>
</body></html>`;
}

// ============================================================
//  FONT EMBED
// ============================================================
async function embedFontsInHTML(html) {
    const fonts = [
        { url: "https://auto.onlinebd.top/fonts/Bangla.ttf", family: "Bangla", weight: "normal" },
        { url: "https://auto.onlinebd.top/fonts/Arial.ttf",  family: "Arial",  weight: "normal" },
    ];
    let fontCSS = "";
    for (const font of fonts) {
        try {
            const res = await axios.get(font.url, { responseType: "arraybuffer", timeout: 15000 });
            const b64 = Buffer.from(res.data).toString("base64");
            fontCSS += `\n@font-face{font-family:'${font.family}';src:url('data:font/truetype;base64,${b64}') format('truetype');font-weight:${font.weight};font-style:normal;}`;
            console.log(`✅ Font embedded: ${font.family} — ${Math.round(res.data.byteLength/1024)}KB`);
        } catch (e) { console.log(`⚠️ Font skip: ${font.url} — ${e.message}`); }
    }
    const overrideCSS = `${fontCSS}\n*{font-family:Bangla,Arial,sans-serif!important;}.bn{font-family:Bangla,sans-serif!important;}.sans{font-family:Arial,sans-serif!important;}`;
    if (html.includes("</head>")) {
        html = html.replace("</head>", `<style id="embedded-fonts">${overrideCSS}</style>\n</head>`);
    } else {
        html = `<style id="embedded-fonts">${overrideCSS}</style>\n` + html;
    }
    return html;
}

// ============================================================
//  PATH FIX
// ============================================================
function fixRelativePaths(html) {
    const BASE = "https://auto.onlinebd.top/bot";
    const patterns = [
        [/(src\s*=\s*["'])(assets\/)/gi,  `$1${BASE}/assets/`],
        [/(href\s*=\s*["'])(assets\/)/gi, `$1${BASE}/assets/`],
        [/(src\s*=\s*["'])(photo\/)/gi,   `$1${BASE}/photo/`],
        [/(src\s*=\s*)(assets\/)/gi,      `$1${BASE}/assets/`],
        [/(href\s*=\s*)(assets\/)/gi,     `$1${BASE}/assets/`],
        [/(src\s*=\s*)(photo\/)/gi,       `$1${BASE}/photo/`],
        [/(url\s*\(\s*["']?)(assets\/)/gi,`$1${BASE}/assets/`],
        [/(url\s*\(\s*["']?)(photo\/)/gi, `$1${BASE}/photo/`],
    ];
    for (const [r, rep] of patterns) html = html.replace(r, rep);
    const doubled = new RegExp(BASE.replace(/\./g,'\\.') + '/' + BASE.replace(/\./g,'\\.').replace('https://',''), 'g');
    html = html.replace(doubled, BASE);
    return html;
}

// ============================================================
//  UTILS
// ============================================================
function parseCookies(str) {
    if (!str) return {};
    return Object.fromEntries(
        str.split(";").map(c => c.trim()).filter(c => c.includes("="))
           .map(c => { const i = c.indexOf("="); return [c.slice(0,i).trim(), c.slice(i+1).trim()]; })
    );
}
function readBody(req) {
    return new Promise(resolve => { let b = ""; req.on("data", c => b += c); req.on("end", () => resolve(b)); });
}
