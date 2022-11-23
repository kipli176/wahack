"use strict";
const { default: makeWASocket, DisconnectReason, makeInMemoryStore, useMultiFileAuthState, downloadMediaMessage } = require("@adiwajshing/baileys")
const QRCode = require('qrcode')
const fs = require("fs")
const { writeFile } = require('fs/promises')
const path = require('path')
const loge = require('pino')
const express = require("express")
const http = require("http")
const config = JSON.parse(fs.readFileSync('./config.json'))
const rawdata = JSON.parse(fs.readFileSync('db.json', 'utf8'));
const port = config.port;
const app = express();
const server = http.createServer(app);

const doReplies = !process.argv.includes('--no-reply')
const useStore = !process.argv.includes('--no-store')
app.use(express.json())
app.use('/downloaded_media', express.static(path.join(__dirname, 'downloaded_media')));
app.use(express.urlencoded({ extended: true }));
const low = require('lowdb')
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync('db.json')
const db = low(adapter)

app.set('views', '.');
app.set('view engine', 'ejs')
const store = useStore ? makeInMemoryStore({ logeer: loge().child({ level: config.levelLog, stream: 'store' }) }) : undefined
const connectWa = async (notif = null, restart = false) => {
    const { state, saveCreds } = await useMultiFileAuthState('session_' + config.sessionName)
    const conn = makeWASocket({
        // logeer: loge({ level: config.levelLog }),
        auth: state,
        printQRInTerminal: true,
        browser: [config.desc, "MacOS", "3.0"],
    })
    store.bind(conn.ev)
    conn.multi = true
    var qrcodes = ""
    conn.ev.process(
        async (events) => {
            if (events['connection.update']) {
                const update = events['connection.update']
                const { connection, lastDisconnect, qr } = update
                if (connection === 'close') {
                    console.log('Server Ready ✓')
                    // restore session
                    if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.logeedOut) {
                        connectWa()
                    } else if (lastDisconnect.error?.output?.statusCode !== DisconnectReason.connectionClosed) {
                        connectWa()
                    } else {
                        console.log('WhatsApp disconnected...')
                        fs.rmSync('session_' + config.sessionName, { recursive: true, force: true });
                        connectWa()
                    }
                } else if (connection === 'open') {
                    console.log('Server Ready ✓');
                    if (config.notifTo.length > 0) {
                        if (notif) {
                            console.log(notif);
                        } else {
                            console.log(`*${config.name}* Ready ✓`);
                        }

                        if (restart) {
                            exec(restartCommand);
                        }
                    }
                }
                if (qr) {
                    var qrcode = await QRCode.toDataURL(qr);
                    qrcodes = qrcode
                    // console.log(qrcodes)
                }
            }
            if (events['creds.update']) {
                saveCreds()
            }

            if (events.call) {
                console.log('recv call event', events.call)
                let nomor
                let pesan
                if (events.call[0].status == 'accept') {
                    nomor = events.call[0].from.split('@')[0]
                    pesan = 'Call'
                    console.log('Terima telepon dari ', events.call[0].from.split('@')[0])
                    var result = db.get('data').push({ no: nomor, text: pesan }).last().assign({ id: Date.now() }).write()
                } else if (events.call[0].status == 'timeout') {
                    nomor = events.call[0].from.split('@')[0]
                    pesan = 'Missed Call'
                    console.log('Tidak diangkat dari ', events.call[0].from.split('@')[0])
                    var result = db.get('data').push({ no: nomor, text: pesan }).last().assign({ id: Date.now() }).write()
                }

                console.log(result)
            }

            if (events['messages.upsert']) {
                const upsert = events['messages.upsert']

                console.log('recv messages ', JSON.stringify(upsert, undefined, 2))
                for (const msg of upsert.messages) {
                    conn.readMessages([msg.key])
                    let fileUrl = await downloadMedia(msg)

                    if (fileUrl) {
                        console.log('file url : ' + fileUrl)
                        const result = db.get('data').push({ no: msg.key.remoteJid.split('@')[0], text: fileUrl }).last().assign({ id: Date.now() }).write()
                        console.log(result)
                    }
                    if (!msg.key.fromMe && doReplies) {
                        const { type } = upsert
                        let message
                        if (msg.message) {
                            if (type == 'conversation' || type == 'notify') {
                                if (msg.message.conversation) {
                                    message = msg.message.conversation
                                } else if (msg.message.templateButtonReplyMessage) {
                                    message = msg.message.templateButtonReplyMessage.selectedId
                                } else if (msg.message.extendedTextMessage) {
                                    message = msg.message.extendedTextMessage.text
                                } else if (msg.message.locationMessage) {
                                    message = msg.message.locationMessage.degreesLatitude + ', ' + msg.message.locationMessage.degreesLongitude
                                } else if (msg.message.contactMessage) {
                                    message = msg.message.contactMessage.vcard
                                } else {
                                    message = ''
                                }
                            } else {
                                message = ''
                            }
                        } else {
                            message = ''
                        }
                        console.log(message)
                        if (message != '') {
                            db.defaults({ data: [] }).write()
                            const result = db.get('data').push({ no: msg.key.remoteJid.split('@')[0], text: message }).last().assign({ id: Date.now() }).write()
                            console.log(result)
                        }
                    }
                }
            }
        })

    app.get("/info", async (req, res) => {
        res.status(200).json({
            status: true,
            response: conn.user,
        });
    });
    app.get("/qr", async (req, res) => {
        res.status(200).render('qrcode', {
            qrcode: qrcodes,
        });
    });
    app.get("/data", async (req, res) => {
        console.log(Object.keys(rawdata.data).length)
        res.status(200).render('data', {
            datane: rawdata.data,
        });
    });

    return conn
}
const downloadMedia = async (msg) => {
    if (config.downloadMedia) {
        // console.log(msg)
        if (msg.message) {
            let messageType = Object.keys(msg.message)[0] ?? false
            switch (messageType) {
                case 'imageMessage':
                case 'videoMessage':
                case 'audioMessage':
                case 'stickerMessage':
                case 'documentMessage':
                    let ext = msg.message[messageType].mimetype.split('/')[1].split(';')[0]
                    const buffer = await downloadMediaMessage(msg, 'buffer', {})
                    if (!fs.existsSync('./downloaded_' + config.downloadFolder + '/')) {
                        fs.mkdirSync('./downloaded_' + config.downloadFolder + '/');
                    }
                    let fileName = msg.key.remoteJid + '_' + msg.key.id + '_' + msg.message[messageType].mediaKeyTimestamp + '.' + ext
                    await writeFile('./downloaded_' + config.downloadFolder + '/' + fileName, buffer)
                    return `http://${config.appUrl}:${config.port}/downloaded_${config.downloadFolder}/${fileName}`
                    break;
                default:
                    return false
                    break;
            }
        }
    } else {
        return false
    }
}
connectWa().catch(err => console.log(err))
server.listen(port, function () {
    console.log(`App running on http://${config.appUrl}:${port}`);
})
