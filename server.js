const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Setup directories
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

const dataFile = path.join(__dirname, 'data.json');
let db = {
  users: {}, // phone -> { phone, username, joinedAt }
  messages: [] // array of message objects
};

// Load existing data if available
if (fs.existsSync(dataFile)) {
  try {
    db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    console.log(`Loaded ${Object.keys(db.users).length} users and ${db.messages.length} messages from database.`);
  } catch (err) {
    console.error("Error loading database, starting fresh:", err);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error("Error saving database:", err);
  }
}

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

// Multer Storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// HTTP APIs

// Register/Login User
app.post('/api/register', (req, res) => {
  const { phone, username } = req.body;
  if (!phone || !username) {
    return res.status(400).json({ error: "Phone and username are required" });
  }

  // Normalize phone number (remove spaces, etc.)
  const cleanPhone = phone.trim().replace(/\s+/g, '');

  if (!db.users[cleanPhone]) {
    db.users[cleanPhone] = {
      phone: cleanPhone,
      username: username.trim(),
      joinedAt: Date.now()
    };
    saveDb();
    console.log(`Registered new user: ${username} (${cleanPhone})`);
  } else {
    // Update username if user already exists
    db.users[cleanPhone].username = username.trim();
    saveDb();
    console.log(`Logged in user: ${username} (${cleanPhone})`);
  }

  res.json(db.users[cleanPhone]);
});

// Get all users
app.get('/api/users', (req, res) => {
  res.json(Object.values(db.users));
});

// Get message history between two users
app.get('/api/messages', (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) {
    return res.status(400).json({ error: "Both user1 and user2 phone numbers are required" });
  }

  const clean1 = user1.trim().replace(/\s+/g, '');
  const clean2 = user2.trim().replace(/\s+/g, '');

  const chatMessages = db.messages.filter(msg => 
    (msg.sender === clean1 && msg.receiver === clean2) ||
    (msg.sender === clean2 && msg.receiver === clean1)
  );

  res.json(chatMessages);
});

// Upload media file (image/video)
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  // Construct absolute URL (using host header)
  const host = req.get('host');
  const protocol = req.protocol;
  const fileUrl = `${protocol}://${host}/uploads/${req.file.filename}`;

  console.log(`Uploaded media file: ${req.file.filename} -> ${fileUrl}`);

  res.json({
    url: fileUrl,
    filename: req.file.filename,
    mimetype: req.file.mimetype,
    size: req.file.size
  });
});

// WebSocket real-time connections map: phone -> ws connection
const clients = new Map();

wss.on('connection', (ws, req) => {
  let clientPhone = null;

  console.log('New WebSocket connection established');

  ws.on('message', (messageStr) => {
    try {
      const data = JSON.parse(messageStr);
      console.log('Received WebSocket event:', data.type);

      switch (data.type) {
        case 'join':
          if (data.phone) {
            clientPhone = data.phone.trim().replace(/\s+/g, '');
            clients.set(clientPhone, ws);
            console.log(`User ${clientPhone} connected via WebSocket`);
            
            // Broadcast user presence/status update if needed
            broadcastPresence();
          }
          break;

        case 'chat':
          // Route chat message
          if (data.sender && data.receiver && data.content) {
            const sender = data.sender.trim().replace(/\s+/g, '');
            const receiver = data.receiver.trim().replace(/\s+/g, '');
            
            const newMsg = {
              id: data.id || `msg-${Date.now()}-${Math.round(Math.random() * 1000)}`,
              sender: sender,
              receiver: receiver,
              type: data.msgType || 'text', // 'text', 'image', 'video'
              content: data.content,
              timestamp: data.timestamp || Date.now()
            };

            db.messages.push(newMsg);
            saveDb();

            // Forward to recipient if online
            const recipientWs = clients.get(receiver);
            if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
              recipientWs.send(JSON.stringify({
                type: 'chat',
                message: newMsg
              }));
              console.log(`Forwarded message from ${sender} to online user ${receiver}`);
            } else {
              console.log(`Stored message from ${sender} to offline user ${receiver}`);
            }

            // Send confirmation back to sender
            ws.send(JSON.stringify({
              type: 'ack',
              messageId: newMsg.id,
              status: 'sent'
            }));
          }
          break;

        case 'typing':
          // Forward typing indicator
          if (data.sender && data.receiver) {
            const receiver = data.receiver.trim().replace(/\s+/g, '');
            const recipientWs = clients.get(receiver);
            if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
              recipientWs.send(JSON.stringify({
                type: 'typing',
                sender: data.sender,
                isTyping: data.isTyping
              }));
            }
          }
          break;
      }
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    if (clientPhone) {
      clients.delete(clientPhone);
      console.log(`User ${clientPhone} disconnected from WebSocket`);
      broadcastPresence();
    }
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for user ${clientPhone}:`, err);
  });
});

function broadcastPresence() {
  const onlineUsers = Array.from(clients.keys());
  const presenceUpdate = JSON.stringify({
    type: 'presence',
    onlineUsers: onlineUsers
  });

  for (const clientWs of clients.values()) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(presenceUpdate);
    }
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HABLO backend server running on http://0.0.0.0:${PORT}`);
});
