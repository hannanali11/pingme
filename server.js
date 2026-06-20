const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client'); // Swapped to Turso client module
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const webpush = require('web-push');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ================= SECURE CRYPTOGRAPHIC PUSH NOTIFICATION SETUP =================
const vapidKeys = webpush.generateVAPIDKeys();
webpush.setVapidDetails(
    'mailto:hannanalikh03@gmail.com',
    vapidKeys.publicKey,
    vapidKeys.privateKey
);

const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

// ================= MULTIPART MEDIA FILE DISK PERSISTENCE ENGINE =================
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 15 * 1024 * 1024 } // 15MB limit for long voice messages
});

// ================= MIDDLEWARE LAYERS =================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
    secret: 'pingme_secure_session_token_key',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        maxAge: 600000,
        secure: false, 
        sameSite: 'lax'
    }
});
app.use(sessionMiddleware);

io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

// ================= TURSO CLOUD SQLITE CONNECTION PIPELINE =================
const db = createClient({
    url: process.env.TURSO_DATABASE_URL || "libsql://pingme-db-hannanali11.aws-ap-south-1.turso.io",
    authToken: process.env.TURSO_AUTH_TOKEN || "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODE5ODYxNjYsImlkIjoiMDE5ZWU2YTYtMGEwMS03ZjQwLWFkNzctNDU1Y2E5OTFiZTMwIiwicmlkIjoiZjE5ODI2OWBeMWNlZS00ODQ2LWFlNDItZTI4NzZjYTgzMjNiIn0.WyPrYpc5hbvESzsu_MYjOoQrahRfGA0QKIKa122TSQjDDBRKprlDixd9ErGhE50RA6AImLW2RjzHgP1GWgirDw"
});

// Asynchronously establish the base core tables
(async () => {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS relationships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL,
            receiver_id INTEGER NOT NULL,
            status TEXT CHECK(status IN ('pending', 'accepted')) DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(sender_id, receiver_id)
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            relationship_id INTEGER NOT NULL,
            sender_id INTEGER NOT NULL,
            message_text TEXT,
            file_path TEXT,
            file_type TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        await db.execute(`CREATE TABLE IF NOT EXISTS push_subscriptions (
            user_id INTEGER PRIMARY KEY,
            subscription_json TEXT NOT NULL
        )`);
        console.log('⚡ Managed Turso SQLite Database Tables ready.');
    } catch (err) {
        console.error('Turso table generation failure:', err.message);
    }
})();

// ================= NODEMAILER TRANSPORT LAYER =================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: 'hannanalikh03@gmail.com', pass: 'qaks enom afzh jdax' }
});

// ================= STATIC PAGE ROUTING =================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));

app.get('/dashboard.html', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/chat.html', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/api/auth/session', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Session expired.' });
    return res.status(200).json({ 
        id: parseInt(req.session.userId), 
        name: req.session.userName, 
        email: req.session.userEmail,
        vapidPublicKey: vapidKeys.publicKey
    });
});

// ================= SUBSCRIPTION WORKER ENROLLMENT LOGIC =================
app.post('/api/notifications/subscribe', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Identity unverified.' });
    const subscriptionStr = JSON.stringify(req.body);

    try {
        await db.execute({
            sql: `INSERT INTO push_subscriptions (user_id, subscription_json) 
                  VALUES (?, ?) 
                  ON CONFLICT(user_id) DO UPDATE SET subscription_json = ?`,
            args: [parseInt(req.session.userId), subscriptionStr, subscriptionStr]
        });
        return res.status(200).json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to preserve notification target bindings.' });
    }
});

// ================= AUTHENTICATION ENDPOINTS =================
app.post('/api/auth/send-otp', async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields are required.' });

    try {
        const checkUser = await db.execute({
            sql: 'SELECT email FROM users WHERE email = ?',
            args: [email]
        });

        if (checkUser.rows.length > 0) return res.status(400).json({ error: 'Email account is already registered.' });

        const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
        req.session.pendingUser = { name, email, password, otp: generatedOtp };

        transporter.sendMail({
            from: '"PingMe Security" <hannanalikh03@gmail.com>',
            to: email,
            subject: 'PingMe Verification Request',
            html: `<p>Your Verification Code: <b>${generatedOtp}</b></p>`
        }, (error) => {
            if (error) return res.status(500).json({ error: 'Failed to dispatch email.' });
            return res.status(200).json({ message: 'Verification key transmitted.' });
        });
    } catch (err) {
        return res.status(500).json({ error: 'Database failure.' });
    }
});

app.post('/api/auth/verify-and-register', async (req, res) => {
    const { otp } = req.body;
    const pending = req.session.pendingUser;
    if (!pending) return res.status(400).json({ error: 'Verification window expired.' });
    if (otp !== pending.otp) return res.status(400).json({ error: 'Invalid verification token.' });

    try {
        const hashedPassword = await bcrypt.hash(pending.password, 10);
        await db.execute({
            sql: 'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
            args: [pending.name, pending.email, hashedPassword]
        });
        req.session.pendingUser = null;
        return res.status(201).json({ message: 'Profile initialized success!' });
    } catch (e) { 
        return res.status(500).json({ error: 'Cryptographic or write execution exception.' }); 
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM users WHERE email = ?',
            args: [email]
        });

        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid email or password.' });
        const user = result.rows[0];

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Invalid email or password.' });

        req.session.userId = parseInt(user.id);
        req.session.userName = user.name;
        req.session.userEmail = user.email;
        return res.status(200).json({ message: 'Access authorized successfully.' });
    } catch (err) {
        return res.status(500).json({ error: 'Internal logging framework exception.' });
    }
});

// ================= EXTENDED SOCIAL INTERACTION ENDPOINTS =================
app.get('/api/social/search', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Identity unverified.' });
    const query = req.query.username.toLowerCase();

    try {
        const result = await db.execute({
            sql: "SELECT id, name, email FROM users WHERE LOWER(name) LIKE ? AND id != ?",
            args: [`%${query}%`, parseInt(req.session.userId)]
        });
        return res.status(200).json(result.rows);
    } catch (err) { 
        return res.status(500).json({ error: 'Searching exception.' }); 
    }
});

app.post('/api/social/request', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Identity unverified.' });
    const { receiverId } = req.body;

    try {
        await db.execute({
            sql: "INSERT INTO relationships (sender_id, receiver_id, status) VALUES (?, ?, 'pending')",
            args: [parseInt(req.session.userId), parseInt(receiverId)]
        });
        return res.status(200).json({ message: 'Request sent.' });
    } catch (err) {
        return res.status(400).json({ error: 'Handshake connection already mapped.' });
    }
});

app.get('/api/social/requests/incoming', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Identity unverified.' });
    try {
        const result = await db.execute({
            sql: `SELECT r.id, r.sender_id, u.name AS sender_name FROM relationships r 
                  JOIN users u ON r.sender_id = u.id WHERE r.receiver_id = ? AND r.status = 'pending'`,
            args: [parseInt(req.session.userId)]
        });
        return res.status(200).json(result.rows);
    } catch (err) {
        return res.status(500).json([]);
    }
});

app.post('/api/social/request/respond', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Identity unverified.' });
    const { requestId, status } = req.body;

    try {
        await db.execute({
            sql: "UPDATE relationships SET status = 'accepted' WHERE id = ? AND receiver_id = ?",
            args: [parseInt(requestId), parseInt(req.session.userId)]
        });
        return res.status(200).json({ message: 'Handshake accepted.' });
    } catch (err) {
        return res.status(500).json({ error: 'Processing error.' });
    }
});

app.get('/api/social/friends', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Identity unverified.' });
    
    try {
        const result = await db.execute({
            sql: `SELECT DISTINCT r.id AS relationship_id, u.id AS friend_id, u.name AS friend_name, u.email AS friend_email
                  FROM relationships r
                  JOIN users u ON u.id = CASE WHEN r.sender_id = ? THEN r.receiver_id ELSE r.sender_id END
                  WHERE (r.sender_id = ? OR r.receiver_id = ?) AND r.status = 'accepted'`,
            args: [parseInt(req.session.userId), parseInt(req.session.userId), parseInt(req.session.userId)]
        });
        return res.status(200).json(result.rows);
    } catch (err) {
         return res.status(500).json({ error: 'Failed to retrieve connection logs.' });
    }
});

app.get('/api/social/messages/:relationshipId', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Identity unverified.' });
    
    const cleanId = parseInt(req.params.relationshipId);
    try {
        const result = await db.execute({
            sql: "SELECT sender_id, message_text, file_path, file_type, timestamp FROM messages WHERE relationship_id = ? ORDER BY id ASC",
            args: [cleanId]
        });
        return res.status(200).json(result.rows);
    } catch (err) {
        return res.status(500).json({ error: 'Database history error' });
    }
});

app.post('/api/social/messages/upload', upload.single('media'), async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Identity unverified.' });
    const { relationshipId, messageText } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No payload received.' });

    const relativePath = `/uploads/${req.file.filename}`;
    
    let detectedType = 'image';
    if (req.file.mimetype.startsWith('video/')) detectedType = 'video';
    else if (req.file.mimetype.startsWith('audio/')) detectedType = 'audio';

    const senderId = parseInt(req.session.userId);
    const cleanRoomId = parseInt(relationshipId);

    try {
        await db.execute({
            sql: "INSERT INTO messages (relationship_id, sender_id, message_text, file_path, file_type) VALUES (?, ?, ?, ?, ?)",
            args: [cleanRoomId, senderId, messageText || null, relativePath, detectedType]
        });
        
        io.to(`room_${cleanRoomId}`).emit('new_message', {
            relationship_id: cleanRoomId,
            sender_id: senderId,
            message_text: messageText || null,
            file_path: relativePath,
            file_type: detectedType,
            timestamp: new Date()
        });
        return res.status(200).json({ success: true });
    } catch (err) {
        return res.status(500).json({ error: "Storage allocation write execution failure." });
    }
});

app.get('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// ================= LIVE SOCKET & WEBRTC SIGNALING CONTROLLER =================
const mappedActiveSockets = {}; 

io.on('connection', (socket) => {
    const sessionUser = socket.request.session;
    if (!sessionUser || !sessionUser.userId) return socket.disconnect();

    const currentAuthedUid = parseInt(sessionUser.userId);
    mappedActiveSockets[currentAuthedUid] = socket.id;

    socket.on('join_chat', ({ relationshipId }) => {
        const cleanRoomId = parseInt(relationshipId);
        socket.join(`room_${cleanRoomId}`);
        console.log(`User ${sessionUser.userId} opened room_${cleanRoomId}`);
    });

    socket.on('send_message', async ({ relationshipId, messageText }) => {
        const senderId = parseInt(sessionUser.userId);
        const cleanRoomId = parseInt(relationshipId);

        try {
            await db.execute({
                sql: "INSERT INTO messages (relationship_id, sender_id, message_text, file_path, file_type) VALUES (?, ?, ?, NULL, NULL)",
                args: [cleanRoomId, senderId, messageText]
            });
            io.to(`room_${cleanRoomId}`).emit('new_message', {
                relationship_id: cleanRoomId,
                sender_id: senderId,
                message_text: messageText,
                file_path: null,
                file_type: null,
                timestamp: new Date()
            });
        } catch (err) {
            console.error("Socket chat tracking crash:", err.message);
        }
    });

    // 1. Dial Voice/Video Call Stream
    socket.on('dial_voice_call', async ({ targetFriendId, relationshipId, rtcOffer, isVideoCall }) => {
        const targetSocketId = mappedActiveSockets[parseInt(targetFriendId)];
        
        if (targetSocketId) {
            io.to(targetSocketId).emit('incoming_call_signal', {
                callerName: sessionUser.userName,
                callerId: currentAuthedUid,
                relationshipId: relationshipId,
                rtcOffer: rtcOffer,
                isVideoCall: !!isVideoCall // Explicit payload syncing flag fixed
            });
        } else {
            try {
                const result = await db.execute({
                    sql: "SELECT subscription_json FROM push_subscriptions WHERE user_id = ?",
                    args: [parseInt(targetFriendId)]
                });

                if (result.rows.length > 0) {
                    const row = result.rows[0];
                    const pushPayload = JSON.stringify({
                        title: isVideoCall ? `Incoming Video Call` : `Incoming Voice Call`,
                        body: `${sessionUser.userName} is dialing your connection...`,
                        relationshipId: relationshipId,
                        callerName: sessionUser.userName
                    });

                    webpush.sendNotification(JSON.parse(row.subscription_json), pushPayload)
                        .catch(err => console.error("Push gateway drop trace:", err.message));
                }
            } catch (err) {
                console.error("Push routing pipeline exception:", err.message);
            }
        }
    });

    // 2. Accept Call
    socket.on('accept_call_signal', ({ targetCallerId, rtcAnswer }) => {
        const hostSocket = mappedActiveSockets[parseInt(targetCallerId)];
        if (hostSocket) {
            io.to(hostSocket).emit('call_accepted_by_peer', { rtcAnswer });
        }
    });

    // 3. ICE Trickle Handling
    socket.on('ice_candidate_leak', ({ targetPeerId, candidate }) => {
        const destinationSocket = mappedActiveSockets[parseInt(targetPeerId)];
        if (destinationSocket) {
            io.to(destinationSocket).emit('incoming_ice_candidate', { candidate });
        }
    });

    // 4. Synchronization of Instant Hangups
    socket.on('hangup_call_signal', ({ targetPeerId }) => {
        const destinationSocket = mappedActiveSockets[parseInt(targetPeerId)];
        if (destinationSocket) {
            io.to(destinationSocket).emit('peer_hung_up_call');
        }
    });

    socket.on('disconnect', () => {
        if (mappedActiveSockets[currentAuthedUid] === socket.id) {
            delete mappedActiveSockets[currentAuthedUid];
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 System active on port: ${PORT}`);
});