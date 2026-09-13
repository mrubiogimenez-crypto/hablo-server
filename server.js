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
  users: {}, // phone -> { phone, username, avatarUrl, joinedAt, latitude, longitude, locationUpdatedAt }
  messages: [], // array of message objects (direct + group)
  groups: {}  // groupId -> { id, name, avatarUrl, members: [], adminPhone, createdAt }
};

// Load existing data if available
if (fs.existsSync(dataFile)) {
  try {
    db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (!db.groups) db.groups = {};
    console.log(`Loaded ${Object.keys(db.users).length} users, ${db.messages.length} messages, ${Object.keys(db.groups).length} groups.`);
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

// ============================================================
// HTTP APIs
// ============================================================

// Register/Login User
app.post('/api/register', (req, res) => {
  const { phone, username, avatarUrl } = req.body;
  if (!phone || !username) {
    return res.status(400).json({ error: "Phone and username are required" });
  }

  const cleanPhone = phone.trim().replace(/\s+/g, '');

  if (!db.users[cleanPhone]) {
    db.users[cleanPhone] = {
      phone: cleanPhone,
      username: username.trim(),
      avatarUrl: avatarUrl || null,
      joinedAt: Date.now(),
      latitude: null,
      longitude: null,
      locationUpdatedAt: null
    };
    saveDb();
    console.log(`Registered new user: ${username} (${cleanPhone})`);
  } else {
    db.users[cleanPhone].username = username.trim();
    if (avatarUrl) {
      db.users[cleanPhone].avatarUrl = avatarUrl;
    }
    saveDb();
    console.log(`Logged in user: ${username} (${cleanPhone})`);
  }

  res.json(db.users[cleanPhone]);
});

// Update Profile Avatar
app.post('/api/user/avatar', (req, res) => {
  const { phone, avatarUrl } = req.body;
  if (!phone || !avatarUrl) {
    return res.status(400).json({ error: "Phone and avatarUrl are required" });
  }

  const cleanPhone = phone.trim().replace(/\s+/g, '');
  if (db.users[cleanPhone]) {
    db.users[cleanPhone].avatarUrl = avatarUrl;
    saveDb();
    console.log(`Updated avatar for user ${cleanPhone}`);

    // Broadcast avatar update to all connected clients
    const updateEvent = JSON.stringify({
      type: 'user_update',
      user: db.users[cleanPhone]
    });
    for (const clientWs of clients.values()) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(updateEvent);
      }
    }

    return res.json(db.users[cleanPhone]);
  }

  res.status(404).json({ error: "User not found" });
});

// Update User Location
app.post('/api/user/location', (req, res) => {
  const { phone, latitude, longitude } = req.body;
  if (!phone || latitude === undefined || longitude === undefined) {
    return res.status(400).json({ error: "phone, latitude, and longitude are required" });
  }

  const cleanPhone = phone.trim().replace(/\s+/g, '');
  if (!db.users[cleanPhone]) {
    return res.status(404).json({ error: "User not found" });
  }

  db.users[cleanPhone].latitude = latitude;
  db.users[cleanPhone].longitude = longitude;
  db.users[cleanPhone].locationUpdatedAt = Date.now();
  saveDb();

  // Broadcast location update to all online users
  const updateEvent = JSON.stringify({
    type: 'user_update',
    user: db.users[cleanPhone]
  });
  for (const clientWs of clients.values()) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(updateEvent);
    }
  }

  res.json(db.users[cleanPhone]);
});

// Get all users
app.get('/api/users', (req, res) => {
  res.json(Object.values(db.users));
});

// Get message history between two direct users
app.get('/api/messages', (req, res) => {
  const { user1, user2 } = req.query;
  if (!user1 || !user2) {
    return res.status(400).json({ error: "Both user1 and user2 phone numbers are required" });
  }

  const clean1 = user1.trim().replace(/\s+/g, '');
  const clean2 = user2.trim().replace(/\s+/g, '');

  const chatMessages = db.messages.filter(msg =>
    !msg.groupId && (
      (msg.sender === clean1 && msg.receiver === clean2) ||
      (msg.sender === clean2 && msg.receiver === clean1)
    )
  );

  res.json(chatMessages);
});

// Get group message history
app.get('/api/groups/:groupId/messages', (req, res) => {
  const { groupId } = req.params;
  if (!db.groups[groupId]) {
    return res.status(404).json({ error: "Group not found" });
  }
  const groupMessages = db.messages.filter(msg => msg.groupId === groupId);
  res.json(groupMessages);
});

// Send message via HTTP (fallback/guaranteed endpoint)
app.post('/api/messages/send', (req, res) => {
  const { id, sender, receiver, msgType, content, groupId } = req.body;
  if (!sender || !receiver || !content) {
    return res.status(400).json({ error: "sender, receiver, and content are required" });
  }

  const cleanSender = sender.trim().replace(/\s+/g, '');
  const cleanReceiver = receiver.trim().replace(/\s+/g, '');

  const newMsg = {
    id: id || `msg-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    sender: cleanSender,
    receiver: cleanReceiver,
    type: msgType || 'text',
    content: content,
    timestamp: Date.now(),
    groupId: groupId || null
  };

  // Avoid duplicates if message with same ID already exists
  const existingIndex = db.messages.findIndex(m => m.id === newMsg.id);
  if (existingIndex < 0) {
    db.messages.push(newMsg);
    saveDb();
  }

  if (groupId && db.groups[groupId]) {
    // Group message: deliver to all group members who are online
    const group = db.groups[groupId];
    for (const memberPhone of group.members) {
      if (memberPhone === cleanSender) continue;
      const memberWs = clients.get(memberPhone);
      if (memberWs && memberWs.readyState === WebSocket.OPEN) {
        memberWs.send(JSON.stringify({ type: 'chat', message: newMsg }));
      }
    }
  } else {
    // Direct message: forward to recipient via WebSocket if online
    const recipientWs = clients.get(cleanReceiver);
    if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
      recipientWs.send(JSON.stringify({ type: 'chat', message: newMsg }));
      console.log(`HTTP Send: Forwarded message from ${cleanSender} to ${cleanReceiver}`);
    } else {
      console.log(`HTTP Send: Stored message from ${cleanSender} to offline user ${cleanReceiver}`);
    }
  }

  res.json({ status: 'sent', message: newMsg });
});

// ============================================================
// Groups API
// ============================================================

// Create a new group
app.post('/api/groups/create', (req, res) => {
  const { name, adminPhone, memberPhones } = req.body;
  if (!name || !adminPhone || !memberPhones || !Array.isArray(memberPhones)) {
    return res.status(400).json({ error: "name, adminPhone, and memberPhones[] are required" });
  }

  const groupId = `grp-${Date.now()}-${Math.round(Math.random() * 1000)}`;
  const members = [...new Set([adminPhone, ...memberPhones])]; // ensure admin is in members, no duplicates

  const group = {
    id: groupId,
    name: name.trim(),
    avatarUrl: null,
    members: members,
    adminPhone: adminPhone.trim(),
    createdAt: Date.now()
  };

  db.groups[groupId] = group;
  saveDb();

  console.log(`Created group "${name}" (${groupId}) with ${members.length} members`);

  // Notify all group members who are online
  const groupUpdateEvent = JSON.stringify({ type: 'group_update', group });
  for (const memberPhone of members) {
    const memberWs = clients.get(memberPhone);
    if (memberWs && memberWs.readyState === WebSocket.OPEN) {
      memberWs.send(groupUpdateEvent);
    }
  }

  res.json(group);
});

// Get groups for a user
app.get('/api/groups', (req, res) => {
  const { phone } = req.query;
  if (!phone) {
    return res.status(400).json({ error: "phone is required" });
  }
  const cleanPhone = phone.trim().replace(/\s+/g, '');
  const userGroups = Object.values(db.groups).filter(g => g.members.includes(cleanPhone));
  res.json(userGroups);
});

// Add member to group
app.post('/api/groups/:groupId/members', (req, res) => {
  const { groupId } = req.params;
  const { phone } = req.body;

  if (!db.groups[groupId]) {
    return res.status(404).json({ error: "Group not found" });
  }

  const cleanPhone = phone.trim().replace(/\s+/g, '');
  if (!db.groups[groupId].members.includes(cleanPhone)) {
    db.groups[groupId].members.push(cleanPhone);
    saveDb();
  }

  res.json(db.groups[groupId]);
});

// Upload media file (image/video)
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

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

// ============================================================
// WebSocket Real-Time
// ============================================================
const clients = new Map(); // phone -> ws

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
            broadcastPresence();
          }
          break;

        case 'chat': {
          if (data.sender && data.receiver && data.content) {
            const sender = data.sender.trim().replace(/\s+/g, '');
            const receiver = data.receiver.trim().replace(/\s+/g, '');
            const groupId = data.groupId || null;

            const newMsg = {
              id: data.id || `msg-${Date.now()}-${Math.round(Math.random() * 1000)}`,
              sender: sender,
              receiver: receiver,
              type: data.msgType || 'text',
              content: data.content,
              timestamp: data.timestamp || Date.now(),
              groupId: groupId
            };

            // Avoid duplicates
            if (!db.messages.find(m => m.id === newMsg.id)) {
              db.messages.push(newMsg);
              saveDb();
            }

            if (groupId && db.groups[groupId]) {
              // Group message delivery
              const group = db.groups[groupId];
              for (const memberPhone of group.members) {
                if (memberPhone === sender) continue;
                const memberWs = clients.get(memberPhone);
                if (memberWs && memberWs.readyState === WebSocket.OPEN) {
                  memberWs.send(JSON.stringify({ type: 'chat', message: newMsg }));
                }
              }
            } else {
              // Direct message delivery
              const recipientWs = clients.get(receiver);
              if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                recipientWs.send(JSON.stringify({ type: 'chat', message: newMsg }));
                console.log(`Forwarded message from ${sender} to ${receiver}`);
              } else {
                console.log(`Stored message from ${sender} to offline user ${receiver}`);
              }
            }

            // ACK to sender
            ws.send(JSON.stringify({ type: 'ack', messageId: newMsg.id, status: 'sent' }));
          }
          break;
        }

        case 'typing':
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

        case 'location_update':
          if (data.phone && data.latitude !== undefined && data.longitude !== undefined) {
            const cleanPhone = data.phone.trim().replace(/\s+/g, '');
            if (db.users[cleanPhone]) {
              db.users[cleanPhone].latitude = data.latitude;
              db.users[cleanPhone].longitude = data.longitude;
              db.users[cleanPhone].locationUpdatedAt = Date.now();
              saveDb();

              // Broadcast to all online users
              const locationUpdateEvent = JSON.stringify({
                type: 'user_update',
                user: db.users[cleanPhone]
              });
              for (const clientWs of clients.values()) {
                if (clientWs.readyState === WebSocket.OPEN) {
                  clientWs.send(locationUpdateEvent);
                }
              }
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
