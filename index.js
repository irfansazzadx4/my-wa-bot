global.crypto = require('crypto');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    delay,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        auth: state,
        version,
        printQRInTerminal: false, // টার্মিনালে QR দেখাবে না
        browser: ["Ubuntu", "Chrome", "121.0.6167.184"], // আধুনিক ব্রাউজার ভার্সন
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: undefined,
    });

    // পেয়ারিং কোড লজিক - কানেকশন ওপেন হওয়ার আগেই এটি রান করতে হয়
    if (!sock.authState.creds.registered) {
        const phoneNumber = "8801846649326"; // আপনার নম্বর
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(phoneNumber);
                console.log('----------------------------');
                console.log(`📱 আপনার পেয়ারিং কোড: ${code}`);
                console.log('----------------------------');
            } catch (err) {
                console.error('❌ পেয়ারিং কোড রিকোয়েস্ট এরর:', err.message);
            }
        }, 5000); // ৫ সেকেন্ড অপেক্ষা যাতে সকেট তৈরি হতে পারে
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log('✅ সফলভাবে কানেক্ট হয়েছে!');
        }

        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log('❌ কানেকশন বন্ধ হয়েছে। কারণ কোড:', reason);
            
            if (reason !== DisconnectReason.loggedOut) {
                console.log('🔄 আবার কানেক্ট করার চেষ্টা করা হচ্ছে...');
                connectToWhatsApp();
            } else {
                console.log('🚫 লগ আউট হয়েছে। ফোল্ডার ডিলিট করে নতুন করে রান করুন।');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;
        
        const messageType = Object.keys(m.message)[0];
        const text = m.message.conversation || m.message.extendedTextMessage?.text;

        if (text === '.ping') {
            await sock.sendMessage(m.key.remoteJid, { text: 'Pong! 🏓' });
        }
    });
}

connectToWhatsApp().catch(err => console.error("Unexpected error:", err));
