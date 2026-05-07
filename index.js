global.crypto = require('crypto');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    delay
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
            console.log('✅ সফলভাবে কানেক্ট হয়েছে!');

            // connection open হওয়ার পর একটু wait করুন
            if (!sock.authState.creds.registered) {
                await delay(2000); // 2 সেকেন্ড অপেক্ষা
                try {
                    const phoneNumber = "8801846649326"; // আপনার নম্বর (কান্ট্রি কোড সহ)
                    const code = await sock.requestPairingCode(phoneNumber);
                    console.log(`📱 পেয়ারিং কোড: ${code}`);
                } catch (err) {
                    console.error('❌ Pairing code error:', err.message);
                }
            }
        }

        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            
            if (reason === DisconnectReason.loggedOut) {
                console.log('🚫 লগ আউট হয়েছে। নতুন করে লগইন করুন।');
            } else {
                console.log('🔄 Reconnecting...');
                connectToWhatsApp();
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        // আপনার message handling এখানে
    });
}

connectToWhatsApp();