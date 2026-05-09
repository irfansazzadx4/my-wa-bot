console.log("🚀 BOT STARTING...");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const pino      = require("pino");
const { Boom }  = require("@hapi/boom");
const http      = require("http");
const qrcode    = require("qrcode");
const { execSync } = require("child_process");
const FormData  = require("form-data");
const axios     = require("axios");
const fs        = require("fs");
const os        = require("os");
const path      = require("path");
const crypto    = require("crypto");
const puppeteer = require("puppeteer");

// ============================================================
//  CONFIG
// ============================================================
const CONFIG = {
    API_EXTRACT_URL : "https://auto.onlinebd.top/Signtonid_api_one.php",
    API_GENERATE_URL: "https://auto.onlinebd.top/bot/nid-bn.php",
    BASE_URL        : "https://auto.onlinebd.top/bot/storage/",
    UPLOAD_API_URL  : "https://auto.onlinebd.top/bot/upload.php",
    USERS_FILE      : "./users.json",
    STATS_FILE      : "./stats.json",
    PORT            : process.env.PORT || 3000,
    ADMIN_PASS      : process.env.ADMIN_PASS || "admin123",
    HTML2PDF_URL    : "https://auto.onlinebd.top/bot/html2pdf.php",
    HTML2PDF_SECRET : "nid_pdf_secret_2025",
    NID_RENDER_URL  : "https://auto.onlinebd.top/bot/nid-render.php",
    SELF_URL        : process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || "",
};

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

// number normalize — সব format কে একই রূপে আনো
// WhatsApp JID: 8801XXXXXXXXX, Admin input: 01XXXXXXXXX বা 8801XXXXXXXXX
function normalizeNumber(num) {
    let n = String(num).replace(/\D/g, ""); // শুধু digits রাখো
    // 11 digit এবং শুরু 01 → বাংলাদেশ, 880 যোগ করো
    if (n.length === 11 && n.startsWith("01")) {
        n = "880" + n.slice(1); // 01XXXXXXXXX → 8801XXXXXXXXX
    }
    return n;
}

function isAllowed(number) {
    const users = getUsers();
    if (users.length === 0) return false;
    const normalized = normalizeNumber(number);
    console.log(`🔍 isAllowed check: raw=${number} normalized=${normalized}`);
    const u = users.find(x => normalizeNumber(x.number) === normalized);
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

// ============================================================
//  HTTP SERVER — QR page + Admin panel
// ============================================================
const adminSessions = new Set();

http.createServer(async (req, res) => {

    const url  = new URL(req.url, `http://localhost`);
    const reqPath = url.pathname; // ✅ FIX #4: 'path_' নামে রাখা (path module এর সাথে conflict এড়াতে)

    if (reqPath === "/test") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("OK BOT RUNNING");
    }

    if (reqPath === "/admin" || reqPath.startsWith("/admin")) {
        await handleAdmin(req, res, url);
        return;
    }

    if (isConnected) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(
            htmlPage(
                "✅ Bot Connected",
                `<div class="connected">✅ WhatsApp Bot সংযুক্ত!</div>
                 <a href="/admin" class="btn">Admin Panel →</a>`
            )
        );
    }

    if (lastQR) {
        try {
            const qrImg = await qrcode.toDataURL(lastQR);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            return res.end(
                htmlPage(
                    "QR Code",
                    `<h2>📱 WhatsApp QR Scan করুন</h2>
                     <img src="${qrImg}" style="width:260px;border:4px solid #25D366;border-radius:12px">
                     <p>WhatsApp → Linked Devices → Link a Device</p>
                     <meta http-equiv="refresh" content="30">`
                )
            );
        } catch {
            res.writeHead(500);
            return res.end("QR error");
        }
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlPage("Loading", `<h2>⏳ QR লোড হচ্ছে...</h2><meta http-equiv="refresh" content="8">`));

}).listen(CONFIG.PORT, () => {
    console.log(`✅ Server: http://localhost:${CONFIG.PORT}`);
    // ── Self-ping: Render sleep থেকে বাঁচাতে প্রতি ১০ মিনিটে ping ──
    startSelfPing();
});

function startSelfPing() {
    const url = CONFIG.SELF_URL;
    if (!url) {
        console.log("⚠️ SELF_URL not set — self-ping disabled. Render এ RENDER_EXTERNAL_URL env var দরকার।");
        return;
    }
    setInterval(async () => {
        try {
            const res = await axios.get(url + "/test", { timeout: 10000 });
            console.log(`🏓 Self-ping OK [${new Date().toLocaleTimeString()}]`);
        } catch (e) {
            console.log(`⚠️ Self-ping failed: ${e.message}`);
        }
    }, 10 * 60 * 1000); // প্রতি ১০ মিনিটে
    console.log(`✅ Self-ping started → ${url}/test`);
}

// ============================================================
//  ADMIN PANEL HANDLER
// ============================================================
async function handleAdmin(req, res, url) {
    const cookies = parseCookies(req.headers.cookie || "");
    const authed  = cookies.admin_sess && adminSessions.has(cookies.admin_sess);

    if (req.method === "POST") {
        const body   = await readBody(req);
        const params = new URLSearchParams(body);
        const action = params.get("action");

        // ✅ FIX #5: if-else if chain — একটি action এর পরে অন্যটি execute হবে না
        if (action === "login") {
            if (params.get("pass") === CONFIG.ADMIN_PASS) {
                const sess = crypto.randomBytes(16).toString("hex"); // ✅ FIX #6: Math.random এর বদলে crypto
                adminSessions.add(sess);
                res.writeHead(302, { "Set-Cookie": `admin_sess=${sess}; Path=/; HttpOnly`, "Location": "/admin" });
                res.end();
            } else {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(adminLogin("❌ ভুল পাসওয়ার্ড!"));
            }
            return;
        }

        if (!authed) {
            res.writeHead(302, { Location: "/admin" });
            res.end();
            return;
        }

        if (action === "add") {
            const rawNum = (params.get("number") || "").replace(/\D/g, "");
            const number = normalizeNumber(rawNum); // সবসময় 8801XXXXXXXXX format এ save
            const name   = (params.get("name")   || "").trim();
            if (number) {
                const users = getUsers();
                if (!users.find(u => normalizeNumber(u.number) === number)) {
                    users.push({ number, name, active: true, added: new Date().toLocaleString("bn-BD") });
                    saveUsers(users);
                }
            }
        } else if (action === "toggle") {
            const num   = params.get("number");
            const users = getUsers();
            const u     = users.find(x => x.number === num);
            if (u) u.active = !u.active;
            saveUsers(users);
        } else if (action === "delete") {
            const num = params.get("number");
            saveUsers(getUsers().filter(u => u.number !== num));
        } else if (action === "logout") {
            adminSessions.delete(cookies.admin_sess);
            res.writeHead(302, { "Set-Cookie": "admin_sess=; Path=/; Max-Age=0", "Location": "/admin" });
            res.end();
            return;
        }

        res.writeHead(302, { Location: "/admin" });
        res.end();
        return;
    }

    // GET
    if (!authed) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(adminLogin(""));
        return;
    }

    const users      = getUsers();
    const stats      = getStats();
    const totalCards = Object.values(stats).reduce((s, x) => s + (x.count || 0), 0);
    const activeUsers = users.filter(u => u.active !== false).length;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(adminDashboard(users, stats, totalCards, activeUsers));
}

// ============================================================
//  GITHUB SESSION SAVE
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
    console.log("📦 Extract response:", JSON.stringify(res.data).substring(0, 300));
    return res.data;
}

// ============================================================
//  MAP API DATA
// ============================================================
function mapAPIData(api) {
    if (!api) throw new Error("Empty API response");
    const ok = api.status === "success" || api.success === true;
    if (!ok) throw new Error(api.message || "API error");
    const d = api.data;
    if (!d) throw new Error("No data in response");

    // ✅ FIX #7: images array safely access করা
    const images = Array.isArray(d.images) ? d.images : [];

    return {
        nationalId : d.nationalId  || d.nid          || "",
        nameBangla : d.nameBangla  || d.name_bn       || "",
        nameEnglish: d.nameEnglish || d.name_en       || "",
        dateOfBirth: d.dateOfBirth || d.dob           || "",
        birthPlace : d.birthPlace  || d.birth_place   || "",
        fatherName : d.fatherName  || d.father_name   || "",
        motherName : d.motherName  || d.mother_name   || "",
        bloodGroup : d.bloodGroup  || d.blood_group   || "",
        address    : d.address     || d.fulladdress   || "",
        userIMG    : images[0]     || d.userIMG       || "", // ✅ safe fallback
        signIMG    : images[1]     || d.signIMG       || "", // ✅ safe fallback
    };
}

// ============================================================
//  PUPPETEER দিয়ে nid-render.php → PDF
// ============================================================
async function generateNIDCard(mappedData) {

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
    }).toString();

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--no-zygote",
                "--single-process",
            ],
        });

        const page = await browser.newPage();

        // POST request intercept করে nid-render.php এ পাঠাও
        await page.setRequestInterception(true);
        let isFirst = true;
        page.on("request", req => {
            if (isFirst) {
                isFirst = false;
                req.continue({
                    method  : "POST",
                    postData: params,
                    headers : {
                        ...req.headers(),
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                });
            } else {
                req.continue();
            }
        });

        // nid-render.php = nid-bn.php কিন্তু window.print() ছাড়া
        await page.goto(CONFIG.NID_RENDER_URL, {
            waitUntil: "networkidle0",
            timeout  : 60000,
        });

        // NID card exact size এ PDF
        const pdfBuf = await page.pdf({
            width          : "856px",
            height         : "540px",
            printBackground: true,
            margin         : { top: "0", right: "0", bottom: "0", left: "0" },
        });

        console.log(`✅ Puppeteer PDF: ${pdfBuf.length} bytes`);
        return Buffer.from(pdfBuf);

    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// ============================================================
//  MAIN BOT
// ============================================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" })),
        },
        printQRInTerminal: false,
        logger           : pino({ level: "fatal" }),
        browser          : ["Chrome (Linux)", "Chrome", "121.0.0"],
        version,
        connectTimeoutMs        : 60000,
        defaultQueryTimeoutMs   : undefined,
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
                console.log("🔴 Logged out — নতুন QR scan করতে হবে।");
                // auth_info মুছে দাও যাতে fresh QR আসে
                try { require("fs").rmSync("auth_info_baileys", { recursive: true, force: true }); } catch {}
            } else {
                // session আছে — ৫ সেকেন্ড পরে auto-reconnect, QR লাগবে না
                const delay = code === 408 ? 5000 : 3000; // timeout হলে একটু বেশি wait
                console.log(`🔄 Auto-reconnecting in ${delay/1000}s...`);
                setTimeout(startBot, delay);
            }
        }
    });

    // ── MESSAGE HANDLER ──
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        console.log(`📨 upsert type=${type} count=${messages.length}`);
        if (type !== "notify") return;

        for (const m of messages) {
            const from    = m.key?.remoteJid || "";
            const rawType = m.message ? Object.keys(m.message)[0] : "none";
            console.log(`📩 from=${from} type=${rawType} fromMe=${m.key?.fromMe}`);

            if (!m.message || m.key.fromMe) continue;

            const number = from
                .replace("@s.whatsapp.net", "")
                .replace("@g.us", "")
                .replace("@lid", "");

            // ── message unwrap: messageContextInfo এর ভেতরে actual message থাকে
            const msg = m.message?.documentWithCaptionMessage?.message
                     || m.message?.viewOnceMessage?.message
                     || m.message;

            const msgType = msg ? Object.keys(msg)[0] : rawType;
            console.log(`📩 unwrapped type=${msgType}`);

            const text = (
                msg?.conversation ||
                msg?.extendedTextMessage?.text || ""
            ).trim();

            // .ping
            if (text === ".ping") {
                await sock.sendMessage(from, { text: "🏓 Pong! Bot সচল আছে।" });
                continue;
            }

            // শুধু PDF handle
            const docMsg = msg?.documentMessage;
            if (!docMsg) {
                if (msgType === "conversation" || msgType === "extendedTextMessage") {
                    await sock.sendMessage(from, {
                        text: "📄 অনুগ্রহ করে আপনার NID-এর *PDF ফাইলটি* পাঠান।",
                    }, { quoted: m });
                }
                continue;
            }

            const mime = docMsg?.mimetype || "";
            if (!mime.includes("pdf")) {
                await sock.sendMessage(from, { text: "❌ শুধুমাত্র PDF ফাইল পাঠান।" }, { quoted: m });
                continue;
            }

            // ── User permission check ──
            if (!isAllowed(number)) {
                await sock.sendMessage(from, {
                    text: "⛔ আপনার নম্বরটি অনুমোদিত নয়।\nঅ্যাডমিনের সাথে যোগাযোগ করুন।",
                }, { quoted: m });
                console.log(`⛔ Blocked: ${number}`);
                continue;
            }

            // ── Process PDF ──
            try {
                await sock.sendMessage(from, {
                    text: "⏳ আপনার NID প্রক্রিয়া করা হচ্ছে...\nঅনুগ্রহ করে একটু অপেক্ষা করুন।",
                }, { quoted: m });

                console.log(`📥 PDF from ${number}`);
                // messageContextInfo wrap হলে inner message দিয়ে download
                const dlMsg = {
                    ...m,
                    message: msg, // unwrapped message
                };
                const inputPdf = await downloadMediaMessage(dlMsg, "buffer", {});
                console.log(`✅ PDF size: ${inputPdf.length} bytes`);

                const apiRes  = await extractNIDFromPDF(inputPdf);
                const mapped  = mapAPIData(apiRes);
                console.log(`✅ Extracted: ${mapped.nameBangla} | ${mapped.nationalId}`);

                const cardPdf = await generateNIDCard(mapped);
                console.log(`✅ PDF generated: ${cardPdf.length} bytes`);

                recordStat(number, mapped.nameBangla || mapped.nameEnglish);

                const name    = mapped.nameBangla || mapped.nameEnglish || "অজানা";
                const nid     = mapped.nationalId || "N/A";
                const pdfName = `NID_${nid}_${Date.now()}.pdf`;

                // PDF ফাইল হিসেবে document send করো
                await sock.sendMessage(from, {
                    document : cardPdf,
                    mimetype : "application/pdf",
                    fileName : pdfName,
                    caption  :
                        `✅ *NID কার্ড প্রস্তুত!*\n\n` +
                        `👤 নাম: ${name}\n` +
                        `🪪 NID: ${nid}\n\n` +
                        `📄 PDF টি সরাসরি Download করুন এবং Print করুন।`,
                }, { quoted: m });

            } catch (err) {
                console.error("❌ Error:", err.message);
                await sock.sendMessage(from, {
                    text: `⚠️ সমস্যা হয়েছে:\n${err.message}\n\nআবার চেষ্টা করুন।`,
                }, { quoted: m });
            }
        }
    });
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
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0f14;color:#e8eaf0;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;}
.box{background:#161b24;border:1px solid #2a3347;border-radius:16px;padding:44px 38px;width:340px;box-shadow:0 0 50px rgba(0,229,160,.07)}
.icon{width:52px;height:52px;background:linear-gradient(135deg,#00e5a0,#0084ff);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;margin:0 auto 18px}
h2{text-align:center;margin-bottom:6px;font-size:1.1rem}
p{text-align:center;color:#6b7894;font-size:.78rem;margin-bottom:26px}
label{display:block;font-size:.72rem;color:#6b7894;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px}
input{width:100%;padding:11px 14px;background:#1e2535;border:1px solid #2a3347;border-radius:9px;color:#e8eaf0;font-size:.9rem;outline:none;margin-bottom:16px}
input:focus{border-color:#00e5a0}
button{width:100%;padding:12px;background:linear-gradient(135deg,#00e5a0,#00c080);border:none;border-radius:9px;color:#0d1a12;font-weight:700;font-size:.95rem;cursor:pointer}
.err{background:rgba(255,69,96,.1);border:1px solid rgba(255,69,96,.3);color:#ff4560;padding:9px 13px;border-radius:8px;font-size:.82rem;margin-bottom:14px;text-align:center}
</style></head><body>
<div class="box">
  <div class="icon">🤖</div>
  <h2>Bot Admin Panel</h2>
  <p>WhatsApp NID Card Bot</p>
  ${error ? `<div class="err">${error}</div>` : ""}
  <form method="POST" action="/admin">
    <input type="hidden" name="action" value="login">
    <label>Password</label>
    <input type="password" name="pass" placeholder="••••••••" autofocus>
    <button type="submit">Login →</button>
  </form>
</div></body></html>`;
}

function adminDashboard(users, stats, totalCards, activeUsers) {
    const statsRows = Object.entries(stats).map(([num, s]) =>
        `<tr><td class="num">${num}</td><td>${s.name||'—'}</td><td class="cnt">${s.count}</td><td class="dt">${s.lastUsed}</td></tr>`
    ).join("") || `<tr><td colspan="4" class="empty">এখনো কেউ ব্যবহার করেনি</td></tr>`;

    const userRows = users.map(u => {
        const active = u.active !== false;
        return `<tr>
        <td class="num">${u.number}</td>
        <td>${u.name||'—'}</td>
        <td><span class="badge ${active?'on':'off'}">${active?'Active':'Inactive'}</span></td>
        <td class="dt">${u.added||''}</td>
        <td>
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
    }).join("") || `<tr><td colspan="5" class="empty">কোনো user নেই</td></tr>`;

return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Admin Panel</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d0f14;color:#e8eaf0;font-family:'Segoe UI',sans-serif;min-height:100vh}
.topbar{background:#161b24;border-bottom:1px solid #2a3347;padding:13px 24px;display:flex;align-items:center;justify-content:space-between}
.t-left{display:flex;align-items:center;gap:11px}
.t-logo{width:34px;height:34px;background:linear-gradient(135deg,#00e5a0,#0084ff);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:17px}
.t-title{font-size:.95rem;font-weight:700}.t-sub{font-size:.7rem;color:#6b7894}
.btn-out{background:transparent;border:1px solid #2a3347;color:#6b7894;padding:6px 14px;border-radius:8px;font-size:.76rem;cursor:pointer;transition:.2s}
.btn-out:hover{border-color:#ff4560;color:#ff4560}
.wrap{max-width:900px;margin:0 auto;padding:24px 18px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:13px;margin-bottom:24px}
.sc{background:#161b24;border:1px solid #2a3347;border-radius:10px;padding:16px 18px}
.sc-label{font-size:.7rem;color:#6b7894;letter-spacing:1px;text-transform:uppercase;margin-bottom:7px}
.sc-val{font-size:2rem;font-weight:700}.green{color:#00e5a0}.blue{color:#0084ff}.red{color:#ff4560}
.card{background:#161b24;border:1px solid #2a3347;border-radius:10px;overflow:hidden;margin-bottom:22px}
.card-head{padding:14px 18px;border-bottom:1px solid #2a3347;font-size:.8rem;color:#00e5a0;letter-spacing:1px;text-transform:uppercase}
.add-form{padding:16px 18px;display:flex;gap:9px;flex-wrap:wrap}
.add-form input{flex:1;min-width:150px;padding:9px 13px;background:#1e2535;border:1px solid #2a3347;border-radius:8px;color:#e8eaf0;font-size:.86rem;outline:none}
.add-form input:focus{border-color:#00e5a0}
.btn-add{padding:9px 20px;background:#00e5a0;border:none;border-radius:8px;color:#0d1a12;font-weight:700;font-size:.86rem;cursor:pointer;white-space:nowrap}
table{width:100%;border-collapse:collapse}
thead th{padding:10px 15px;text-align:left;font-size:.7rem;color:#6b7894;letter-spacing:1px;text-transform:uppercase;border-bottom:1px solid #2a3347}
tbody td{padding:12px 15px;font-size:.84rem;border-bottom:1px solid rgba(42,51,71,.5);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover{background:rgba(255,255,255,.02)}
.num{color:#0084ff;font-family:monospace}.cnt{color:#00e5a0;font-weight:700}.dt{color:#6b7894;font-size:.76rem}
.badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:.7rem;font-weight:700}
.on{background:rgba(0,229,160,.12);color:#00e5a0}.off{background:rgba(255,69,96,.1);color:#ff4560}
.empty{text-align:center;color:#6b7894;padding:30px}
.btn-sm{padding:4px 10px;border-radius:6px;font-size:.74rem;font-family:inherit;cursor:pointer;border:1px solid;font-weight:600;transition:.2s;margin-right:4px}
.btn-sm.warn{border-color:rgba(255,165,0,.4);color:#ffa500;background:rgba(255,165,0,.08)}
.btn-sm.warn:hover{background:rgba(255,165,0,.2)}
.btn-sm.ok{border-color:rgba(0,229,160,.4);color:#00e5a0;background:rgba(0,229,160,.08)}
.btn-sm.ok:hover{background:rgba(0,229,160,.2)}
.btn-sm.danger{border-color:rgba(255,69,96,.3);color:#ff4560;background:rgba(255,69,96,.06)}
.btn-sm.danger:hover{background:rgba(255,69,96,.2)}
@media(max-width:600px){.stats{grid-template-columns:1fr 1fr}}
</style></head><body>
<div class="topbar">
  <div class="t-left">
    <div class="t-logo">🤖</div>
    <div><div class="t-title">Bot Admin Panel</div><div class="t-sub">WhatsApp NID Card Bot</div></div>
  </div>
  <form method="POST"><input type="hidden" name="action" value="logout">
    <button class="btn-out" type="submit">Logout</button></form>
</div>
<div class="wrap">
  <div class="stats">
    <div class="sc"><div class="sc-label">মোট Users</div><div class="sc-val blue">${users.length}</div></div>
    <div class="sc"><div class="sc-label">Active</div><div class="sc-val green">${activeUsers}</div></div>
    <div class="sc"><div class="sc-label">মোট Cards</div><div class="sc-val green">${totalCards}</div></div>
  </div>

  <div class="card">
    <div class="card-head">➕ নতুন Number যোগ করুন</div>
    <form method="POST" class="add-form">
      <input type="hidden" name="action" value="add">
      <input type="text" name="number" placeholder="8801846649326 (দেশ কোড সহ)" required>
      <input type="text" name="name" placeholder="নাম (ঐচ্ছিক)">
      <button type="submit" class="btn-add">যোগ করুন</button>
    </form>
  </div>

  <div class="card">
    <div class="card-head">📋 অনুমোদিত Numbers</div>
    <table><thead><tr><th>Number</th><th>নাম</th><th>Status</th><th>যোগের তারিখ</th><th>Action</th></tr></thead>
    <tbody>${userRows}</tbody></table>
  </div>

  <div class="card">
    <div class="card-head">📊 Card Generation Statistics</div>
    <table><thead><tr><th>Number</th><th>নাম</th><th>Cards</th><th>শেষ ব্যবহার</th></tr></thead>
    <tbody>${statsRows}</tbody></table>
  </div>
</div></body></html>`;
}

// ============================================================
//  UTILS
// ============================================================
function parseCookies(str) {
    // ✅ FIX #8: malformed cookie crash fix — try-catch + filter empty
    if (!str) return {};
    return Object.fromEntries(
        str.split(";")
           .map(c => c.trim())
           .filter(c => c.includes("="))           // ✅ "=" ছাড়া entry skip
           .map(c => {
               const idx = c.indexOf("=");         // ✅ শুধু প্রথম "=" এ split
               return [
                   decodeURIComponent(c.slice(0, idx).trim()),
                   decodeURIComponent(c.slice(idx + 1).trim()),
               ];
           })
    );
}

function readBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => resolve(body));
    });
}
