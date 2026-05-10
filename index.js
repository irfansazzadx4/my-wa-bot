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
    PORT            : process.env.PORT || 3000,
    ADMIN_PASS      : process.env.ADMIN_PASS || "admin123",
    PDF_API_URL     : process.env.PDF_API_URL || "",
    PDF_API_SECRET  : process.env.PDF_API_SECRET || "nid_pdf_secret_2025",
    SELF_URL        : process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || "",
};

// ============================================================
//  PENDING STORE — user confirm করার আগে data এখানে থাকবে
//  key: number (string), value: { mappedData, htmlUrl, timestamp }
// ============================================================
const pendingMap = new Map();

// ১০ মিনিট পর auto-expire
function setPending(number, data) {
    pendingMap.set(number, { ...data, timestamp: Date.now() });
    setTimeout(() => pendingMap.delete(number), 10 * 60 * 1000);
}
function getPending(number) {
    return pendingMap.get(number) || null;
}
function clearPending(number) {
    pendingMap.delete(number);
}

// ============================================================
//  HELPERS — Users & Stats
// ============================================================
function loadJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { return fallback; }
}
function saveJSON(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function getUsers()   { return loadJSON(CONFIG.USERS_FILE, []); }
function saveUsers(u) { saveJSON(CONFIG.USERS_FILE, u); }
function getStats()   { return loadJSON(CONFIG.STATS_FILE, {}); }

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

function recordStat(number, name) {
    const stats = getStats();
    if (!stats[number]) stats[number] = { name, count: 0, lastUsed: "" };
    stats[number].count++;
    stats[number].lastUsed = new Date().toLocaleString("bn-BD");
    stats[number].name = name || stats[number].name;
    saveJSON(CONFIG.STATS_FILE, stats);
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

    // storage file serve
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
            const number = normalizeNumber(params.get("number") || "");
            const name   = (params.get("name") || "").trim();
            if (number) {
                const users = getUsers();
                if (!users.find(u => normalizeNumber(u.number) === number)) {
                    users.push({ number, name, active: true, added: new Date().toLocaleString("bn-BD") });
                    saveUsers(users);
                }
            }
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
        }

        res.writeHead(302, { Location: "/admin" }); return res.end();
    }

    if (!authed) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(adminLogin(""));
    }

    const users       = getUsers();
    const stats       = getStats();
    const totalCards  = Object.values(stats).reduce((s, x) => s + (x.count || 0), 0);
    const activeUsers = users.filter(u => u.active !== false).length;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(adminDashboard(users, stats, totalCards, activeUsers));
}

// ============================================================
//  GITHUB SESSION
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
    } catch (e) { console.log("⚠️ GitHub push:", e.message); }
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
//  STEP 1 — HTML বানাও, storage তে save করো, link return করো
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

    // relative → absolute URL (সব ধরনের pattern cover করা)
    html = fixRelativePaths(html);

    // window.print() remove করো — user শুধু দেখবে
    html = html.replace(/window\.print\(\);?/g, "// print removed");

    // font check banner inject করো
    const banner = `
<div id="font-check-banner" style="position:fixed;bottom:0;left:0;right:0;background:#1a1a2e;color:#fff;
padding:14px 20px;text-align:center;z-index:9999;font-family:Arial,sans-serif;font-size:14px;
box-shadow:0 -3px 15px rgba(0,0,0,0.4);">
  <span id="font-status">⏳ Font চেক হচ্ছে...</span>
  &nbsp;&nbsp;
  <span style="color:#aaa;font-size:12px;">
    বাংলা ও ছবি ঠিকমতো দেখা গেলে WhatsApp এ 
    <b style="color:#00e5a0;">✅ OK</b> লিখে পাঠান। সমস্যা হলে 
    <b style="color:#ff4560;">❌ NO</b> লিখুন।
  </span>
</div>
<script>
(function(){
  var t = document.getElementById('font-status');
  // বাংলা font check
  var testEl = document.createElement('span');
  testEl.style.cssText = 'position:absolute;visibility:hidden;font-family:Bangla,sans-serif;font-size:20px';
  testEl.textContent = 'বাংলা';
  document.body.appendChild(testEl);
  var bnW = testEl.offsetWidth;
  testEl.style.fontFamily = 'monospace';
  var monoW = testEl.offsetWidth;
  document.body.removeChild(testEl);
  var fontOk = bnW !== monoW;

  // image check
  var imgs = document.querySelectorAll('img');
  var imgOk = true;
  imgs.forEach(function(img){ if(!img.complete || img.naturalWidth === 0) imgOk = false; });

  if(fontOk && imgOk){
    t.innerHTML = '✅ Font ও ছবি সব ঠিক আছে!';
    t.style.color = '#00e5a0';
  } else if(!fontOk && !imgOk){
    t.innerHTML = '❌ Font ও ছবি দুটোই load হয়নি!';
    t.style.color = '#ff4560';
  } else if(!fontOk){
    t.innerHTML = '⚠️ বাংলা Font load হয়নি (ছবি ঠিক আছে)';
    t.style.color = '#ffa500';
  } else {
    t.innerHTML = '⚠️ কিছু ছবি load হয়নি (Font ঠিক আছে)';
    t.style.color = '#ffa500';
  }
})();
</script>`;

    html = html.replace("</body>", banner + "\n</body>");

    const filename = `${Date.now()}_preview.html`;
    const filepath = path.join(CONFIG.STORAGE_DIR, filename);
    fs.writeFileSync(filepath, html);

    // Railway নিজের URL দিয়ে serve করো (SELF_URL env variable থেকে)
    const serveBase = (CONFIG.SELF_URL || '').replace(/\/$/, '') + '/storage/';
    const finalUrl  = serveBase ? serveBase + filename : CONFIG.BASE_URL + filename;

    console.log('📁 Saved: ' + filepath);
    console.log('🔗 URL: ' + finalUrl);

    return finalUrl;
}

// ============================================================
//  STEP 2 — Railway Puppeteer API তে PDF generate করো
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

    // relative → absolute URL
    html = fixRelativePaths(html);

    // ✅ Font গুলো base64 করে HTML এ embed করো
    // এতে Puppeteer server এ আলাদা font না থাকলেও কাজ করবে
    html = await embedFontsInHTML(html);
    console.log(`✅ Fonts embedded, HTML size: ${html.length} chars`);

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
        await sock.sendMessage(from, {
            text: isAllowed(number) ? "✅ আপনি অনুমোদিত। PDF পাঠান।" : "⛔ আপনি অনুমোদিত নন।"
        });
        return;
    }

    // ── ✅ OK — user confirm করলে PDF generate করো ──
    if (text.toLowerCase() === "ok" || text === "✅" || text === "✅ ok") {
        const pending = getPending(number);
        if (!pending) {
            await sock.sendMessage(from, { text: "⚠️ কোনো pending NID নেই। আগে PDF পাঠান।" }, { quoted: m });
            return;
        }

        await sock.sendMessage(from, { text: "⏳ PDF তৈরি হচ্ছে... একটু অপেক্ষা করুন।" }, { quoted: m });

        try {
            const pdfBuffer = await generatePDFFromMapped(pending.mappedData);
            clearPending(number);
            recordStat(number, pending.mappedData.nameBangla || pending.mappedData.nameEnglish);

            const name    = pending.mappedData.nameBangla || pending.mappedData.nameEnglish || "অজানা";
            const nid     = pending.mappedData.nationalId || "N/A";
            const pdfName = `NID_${nid}.pdf`;

            await sock.sendMessage(from, {
                document : pdfBuffer,
                mimetype : "application/pdf",
                fileName : pdfName,
                caption  :
                    `✅ *NID কার্ড প্রস্তুত!*\n\n` +
                    `👤 নাম: ${name}\n` +
                    `🪪 NID: ${nid}\n\n` +
                    `📄 PDF ডাউনলোড করুন এবং Print করুন।`,
            }, { quoted: m });

            console.log(`✅ PDF sent to ${number}`);
        } catch (err) {
            console.error("❌ PDF error:", err.message);
            await sock.sendMessage(from, { text: `⚠️ PDF তৈরিতে সমস্যা:\n${err.message}` }, { quoted: m });
        }
        return;
    }

    // ── ❌ NO — user বাতিল করলে ──
    if (text.toLowerCase() === "no" || text === "❌" || text === "❌ no") {
        if (getPending(number)) {
            clearPending(number);
            await sock.sendMessage(from, {
                text: "❌ বাতিল করা হয়েছে। আবার সঠিক PDF পাঠান।"
            }, { quoted: m });
        }
        return;
    }

    // ── PDF document ──
    const docMsg = msg?.documentMessage;
    if (!docMsg) {
        if (msgType === "conversation" || msgType === "extendedTextMessage") {
            const pending = getPending(number);
            if (pending) {
                // reminder দাও
                await sock.sendMessage(from, {
                    text:
                        `ℹ️ আপনার NID preview অপেক্ষায় আছে।\n\n` +
                        `🔗 Link: ${pending.htmlUrl}\n\n` +
                        `Font ও ছবি ঠিক থাকলে *OK* লিখুন।\n` +
                        `সমস্যা থাকলে *NO* লিখুন।`,
                }, { quoted: m });
            } else {
                await sock.sendMessage(from, {
                    text: "📄 অনুগ্রহ করে আপনার NID-এর *PDF ফাইলটি* পাঠান।"
                }, { quoted: m });
            }
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

    // ── PDF Process: Step 1 — Extract + HTML preview ──
    await sock.sendMessage(from, {
        text: "⏳ PDF বিশ্লেষণ করা হচ্ছে..."
    }, { quoted: m });

    try {
        const dlMsg    = { ...m, message: msg };
        const pdfBuf   = await downloadMediaMessage(dlMsg, "buffer", {});
        if (!pdfBuf || pdfBuf.length < 100) throw new Error("PDF download failed or empty");
        console.log(`✅ PDF: ${pdfBuf.length} bytes from ${number}`);

        const apiRes   = await extractNIDFromPDF(pdfBuf);
        const mapped   = mapAPIData(apiRes);
        if (!mapped.nationalId && !mapped.nameBangla) throw new Error("NID তথ্য বের করা যায়নি।");
        console.log(`✅ Extracted: ${mapped.nameBangla} | ${mapped.nationalId}`);

        // HTML preview বানাও
        const htmlUrl  = await buildAndSaveHTML(mapped);
        console.log(`✅ Preview: ${htmlUrl}`);

        // pending এ রাখো
        setPending(number, { mappedData: mapped, htmlUrl });

        const name = mapped.nameBangla || mapped.nameEnglish || "অজানা";
        const nid  = mapped.nationalId || "N/A";

        // user কে preview link পাঠাও
        await sock.sendMessage(from, {
            text:
                `✅ *NID তথ্য পাওয়া গেছে!*\n\n` +
                `👤 নাম: ${name}\n` +
                `🪪 NID: ${nid}\n\n` +
                `🔗 নিচের link এ ক্লিক করে কার্ডের preview দেখুন:\n${htmlUrl}\n\n` +
                `─────────────────\n` +
                `📋 *Preview চেক করুন:*\n` +
                `• বাংলা Font ঠিকমতো দেখাচ্ছে?\n` +
                `• ছবি ও সাক্ষর দেখা যাচ্ছে?\n` +
                `• তথ্য সঠিক আছে?\n\n` +
                `✅ সব ঠিক থাকলে → *OK* লিখুন\n` +
                `❌ সমস্যা থাকলে → *NO* লিখুন\n\n` +
                `_(এই link ১০ মিনিট valid থাকবে)_`,
        }, { quoted: m });

    } catch (err) {
        console.error("❌ Process error:", err.message);
        clearPending(number);
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

function adminDashboard(users, stats, totalCards, activeUsers) {
    const statsRows = Object.entries(stats).map(([num, s]) =>
        `<tr><td class="num">${num}</td><td>${s.name||'—'}</td><td class="cnt">${s.count}</td><td class="dt">${s.lastUsed}</td></tr>`
    ).join("") || `<tr><td colspan="4" class="empty">এখনো কেউ ব্যবহার করেনি</td></tr>`;

    const userRows = users.map(u => {
        const active = u.active !== false;
        return `<tr>
        <td class="num">${u.number}</td><td>${u.name||'—'}</td>
        <td><span class="badge ${active?'on':'off'}">${active?'Active':'Inactive'}</span></td>
        <td class="dt">${u.added||''}</td>
        <td>
          <form method="POST" style="display:inline"><input type="hidden" name="action" value="toggle">
            <input type="hidden" name="number" value="${u.number}">
            <button class="btn-sm ${active?'warn':'ok'}">${active?'Deactivate':'Activate'}</button></form>
          <form method="POST" style="display:inline" onsubmit="return confirm('মুছবেন?')">
            <input type="hidden" name="action" value="delete"><input type="hidden" name="number" value="${u.number}">
            <button class="btn-sm danger">Delete</button></form>
        </td></tr>`;
    }).join("") || `<tr><td colspan="5" class="empty">কোনো user নেই</td></tr>`;

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin Panel</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0d0f14;color:#e8eaf0;font-family:'Segoe UI',sans-serif;min-height:100vh}
.topbar{background:#161b24;border-bottom:1px solid #2a3347;padding:13px 24px;display:flex;align-items:center;justify-content:space-between}
.t-left{display:flex;align-items:center;gap:11px}.t-logo{width:34px;height:34px;background:linear-gradient(135deg,#00e5a0,#0084ff);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:17px}
.t-title{font-size:.95rem;font-weight:700}.t-sub{font-size:.7rem;color:#6b7894}
.btn-out{background:transparent;border:1px solid #2a3347;color:#6b7894;padding:6px 14px;border-radius:8px;font-size:.76rem;cursor:pointer}
.btn-out:hover{border-color:#ff4560;color:#ff4560}
.wrap{max-width:900px;margin:0 auto;padding:24px 18px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:13px;margin-bottom:24px}
.sc{background:#161b24;border:1px solid #2a3347;border-radius:10px;padding:16px 18px}
.sc-label{font-size:.7rem;color:#6b7894;letter-spacing:1px;text-transform:uppercase;margin-bottom:7px}
.sc-val{font-size:2rem;font-weight:700}.green{color:#00e5a0}.blue{color:#0084ff}
.card{background:#161b24;border:1px solid #2a3347;border-radius:10px;overflow:hidden;margin-bottom:22px}
.card-head{padding:14px 18px;border-bottom:1px solid #2a3347;font-size:.8rem;color:#00e5a0;letter-spacing:1px;text-transform:uppercase}
.add-form{padding:16px 18px;display:flex;gap:9px;flex-wrap:wrap}
.add-form input{flex:1;min-width:150px;padding:9px 13px;background:#1e2535;border:1px solid #2a3347;border-radius:8px;color:#e8eaf0;font-size:.86rem;outline:none}
.add-form input:focus{border-color:#00e5a0}
.btn-add{padding:9px 20px;background:#00e5a0;border:none;border-radius:8px;color:#0d1a12;font-weight:700;font-size:.86rem;cursor:pointer}
table{width:100%;border-collapse:collapse}
thead th{padding:10px 15px;text-align:left;font-size:.7rem;color:#6b7894;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid #2a3347}
tbody td{padding:12px 15px;font-size:.84rem;border-bottom:1px solid rgba(42,51,71,.5);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}tbody tr:hover{background:rgba(255,255,255,.02)}
.num{color:#0084ff;font-family:monospace}.cnt{color:#00e5a0;font-weight:700}.dt{color:#6b7894;font-size:.76rem}
.badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:.7rem;font-weight:700}
.on{background:rgba(0,229,160,.12);color:#00e5a0}.off{background:rgba(255,69,96,.1);color:#ff4560}
.empty{text-align:center;color:#6b7894;padding:30px}
.btn-sm{padding:4px 10px;border-radius:6px;font-size:.74rem;font-family:inherit;cursor:pointer;border:1px solid;font-weight:600;margin-right:4px}
.btn-sm.warn{border-color:rgba(255,165,0,.4);color:#ffa500;background:rgba(255,165,0,.08)}
.btn-sm.ok{border-color:rgba(0,229,160,.4);color:#00e5a0;background:rgba(0,229,160,.08)}
.btn-sm.danger{border-color:rgba(255,69,96,.3);color:#ff4560;background:rgba(255,69,96,.06)}
@media(max-width:600px){.stats{grid-template-columns:1fr 1fr}}</style></head>
<body>
<div class="topbar"><div class="t-left"><div class="t-logo">🤖</div>
  <div><div class="t-title">Bot Admin Panel</div><div class="t-sub">WhatsApp NID Card Bot</div></div></div>
  <form method="POST"><input type="hidden" name="action" value="logout">
  <button class="btn-out">Logout</button></form></div>
<div class="wrap">
  <div class="stats">
    <div class="sc"><div class="sc-label">মোট Users</div><div class="sc-val blue">${users.length}</div></div>
    <div class="sc"><div class="sc-label">Active</div><div class="sc-val green">${activeUsers}</div></div>
    <div class="sc"><div class="sc-label">মোট Cards</div><div class="sc-val green">${totalCards}</div></div>
  </div>
  <div class="card"><div class="card-head">➕ নতুন Number যোগ করুন</div>
    <form method="POST" class="add-form"><input type="hidden" name="action" value="add">
    <input type="text" name="number" placeholder="8801846649326 (দেশ কোড সহ)" required>
    <input type="text" name="name" placeholder="নাম (ঐচ্ছিক)">
    <button type="submit" class="btn-add">যোগ করুন</button></form></div>
  <div class="card"><div class="card-head">📋 অনুমোদিত Numbers</div>
    <table><thead><tr><th>Number</th><th>নাম</th><th>Status</th><th>যোগের তারিখ</th><th>Action</th></tr></thead>
    <tbody>${userRows}</tbody></table></div>
  <div class="card"><div class="card-head">📊 Card Generation Statistics</div>
    <table><thead><tr><th>Number</th><th>নাম</th><th>Cards</th><th>শেষ ব্যবহার</th></tr></thead>
    <tbody>${statsRows}</tbody></table></div>
</div></body></html>`;
}


// ============================================================
//  FONT EMBED — Bangla + Arial font কে base64 করে HTML এ embed করো
//  এতে Puppeteer আলাদা font খুঁজবে না, সব HTML এর ভেতরেই থাকবে
// ============================================================
async function embedFontsInHTML(html) {
    const BASE = "https://auto.onlinebd.top/bot";

    // Font URLs — server থেকে download করে base64 করা হবে
    const fonts = [
        {
            url    : "https://auto.onlinebd.top/fonts/Bangla.ttf",
            family : "Bangla",
            weight : "normal",
        },
        {
            url    : "https://auto.onlinebd.top/fonts/Arial.ttf",
            family : "Arial",
            weight : "normal",
        },
    ];

    let fontCSS = "";

    for (const font of fonts) {
        try {
            const res = await axios.get(font.url, {
                responseType: "arraybuffer",
                timeout: 15000,
            });
            const b64  = Buffer.from(res.data).toString("base64");
            const mime = "font/truetype";
            fontCSS += `
@font-face {
    font-family: '${font.family}';
    src: url('data:${mime};base64,${b64}') format('truetype');
    font-weight: ${font.weight};
    font-style: normal;
}`;
            console.log(`✅ Font embedded: ${font.family} (${font.weight}) — ${Math.round(res.data.byteLength/1024)}KB`);
        } catch (e) {
            console.log(`⚠️ Font not found: ${font.url} — ${e.message}`);
        }
    }

    const overrideCSS = `
${fontCSS}

/* Force fonts — same rule as nid-bn.php */
* { font-family: Bangla, Arial, sans-serif !important; }
.bn { font-family: Bangla, sans-serif !important; }
.sans { font-family: Arial, sans-serif !important; }
`;

    // <head> এ inject করো
    if (html.includes("</head>")) {
        html = html.replace("</head>", `<style id="embedded-fonts">${overrideCSS}</style>\n</head>`);
    } else {
        html = `<style id="embedded-fonts">${overrideCSS}</style>\n` + html;
    }

    return html;
}

// ============================================================
//  PATH FIX — relative → absolute URL
// ============================================================
function fixRelativePaths(html) {
    const BASE = "https://auto.onlinebd.top/bot";

    // সব ধরনের pattern cover করা:
    // src="assets/..."   src='assets/...'   src=assets/...
    // href="assets/..."  url(assets/...)
    // photo/ এর জন্যও same

    const patterns = [
        // src="assets/ বা src='assets/
        [/(src\s*=\s*["'])(assets\/)/gi,  `$1${BASE}/assets/`],
        [/(href\s*=\s*["'])(assets\/)/gi, `$1${BASE}/assets/`],
        [/(src\s*=\s*["'])(photo\/)/gi,   `$1${BASE}/photo/`],

        // src=assets/ (quote ছাড়া)
        [/(src\s*=\s*)(assets\/)/gi,  `$1${BASE}/assets/`],
        [/(href\s*=\s*)(assets\/)/gi, `$1${BASE}/assets/`],
        [/(src\s*=\s*)(photo\/)/gi,   `$1${BASE}/photo/`],

        // url(assets/
        [/(url\s*\(\s*["']?)(assets\/)/gi, `$1${BASE}/assets/`],
        [/(url\s*\(\s*["']?)(photo\/)/gi,  `$1${BASE}/photo/`],
    ];

    for (const [regex, replacement] of patterns) {
        html = html.replace(regex, replacement);
    }

    // double replace হয়ে গেলে fix করো
    const doubled = new RegExp(BASE.replace(/\./g, '\\.') + '/' + BASE.replace(/\./g, '\\.').replace('https://', ''), 'g');
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
