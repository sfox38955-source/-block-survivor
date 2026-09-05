// =====================================================================
// Block Survivor - Online Co-op — Server
// Express (serves the client) + Socket.io (real-time) + a tiny JSON
// file store for accounts/friends. Runs the authoritative game engine
// per room at a fixed tick rate and broadcasts snapshots to clients.
// =====================================================================
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const crypto = require('crypto');
const Engine = require('./engine');

const PORT = process.env.PORT || 8080;
const DATA_FILE = path.join(__dirname, 'data.json');
const TICK_RATE = 30; // simulation steps per second
const SNAPSHOT_RATE = 20; // network snapshots per second
const VOTE_SECONDS = Number(process.env.VOTE_SECONDS || 20);
const MAX_TEAM_SIZE = 4;

// ---------------------------------------------------------------
// Tiny JSON-file backed store for accounts & friendships.
// Not a real database — good enough for a small self-hosted game.
// ---------------------------------------------------------------
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return { users: {} }; }
}
let db = loadData();
let saveScheduled = false;
function saveData() {
  if (saveScheduled) return;
  saveScheduled = true;
  setTimeout(() => { saveScheduled = false; fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), () => {}); }, 250);
}
function ensureUser(username) {
  if (!db.users[username]) db.users[username] = { token: crypto.randomBytes(16).toString('hex'), friends: [], incoming: [], outgoing: [] };
  return db.users[username];
}

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

// ---------------------------------------------------------------
// In-memory runtime state
// ---------------------------------------------------------------
/** username -> socket.id (only while connected) */
const online = new Map();
/** socket.id -> username */
const socketUser = new Map();
/** roomCode -> Room */
const rooms = new Map();

class Room {
  constructor(code, hostUsername, teamSizeMax) {
    this.code = code;
    this.hostUsername = hostUsername;
    this.teamSizeMax = Math.min(MAX_TEAM_SIZE, Math.max(1, teamSizeMax || MAX_TEAM_SIZE));
    this.members = new Map(); // username -> { ready }
    this.members.set(hostUsername, { ready: false });
    this.status = 'lobby'; // lobby | playing | gameover
    this.engine = null;
    this.loop = null;
    this.snapshotLoop = null;
    this.vote = null; // { choices, votes: Map(username->cardId), timer }
  }
  broadcastLobby() {
    io.to(this.code).emit('room:update', {
      roomCode: this.code,
      hostUsername: this.hostUsername,
      teamSizeMax: this.teamSizeMax,
      status: this.status,
      members: Array.from(this.members.entries()).map(([username, m]) => ({ username, ready: m.ready, online: online.has(username) })),
    });
  }
}

function socketFor(username) { const id = online.get(username); return id ? io.sockets.sockets.get(id) : null; }
function emitTo(username, event, payload) { const s = socketFor(username); if (s) s.emit(event, payload); }

function leaveRoom(username) {
  for (const room of rooms.values()) {
    if (room.members.has(username)) {
      room.members.delete(username);
      if (room.engine && room.engine.players) {
        const p = Object.values(room.engine.players).find(p => p.name === username);
        if (p) p.connected = false;
      }
      if (room.members.size === 0) {
        stopRoom(room);
        rooms.delete(room.code);
      } else {
        if (room.hostUsername === username) room.hostUsername = room.members.keys().next().value;
        room.broadcastLobby();
      }
      return room.code;
    }
  }
  return null;
}

function stopRoom(room) {
  if (room.loop) clearInterval(room.loop);
  if (room.snapshotLoop) clearInterval(room.snapshotLoop);
  if (room.vote && room.vote.timer) clearTimeout(room.vote.timer);
  room.loop = null; room.snapshotLoop = null;
}

function startGame(room) {
  room.status = 'playing';
  room.engine = Engine.createEngine();
  for (const username of room.members.keys()) {
    const p = Engine.createPlayer(username, username);
    room.engine.players[username] = p;
  }
  room.broadcastLobby();
  io.to(room.code).emit('game:start', { players: Array.from(room.members.keys()) });

  let acc = 0;
  const dt = 1 / TICK_RATE;
  room.loop = setInterval(() => {
    if (room.status !== 'playing') return;
    try {
      Engine.tick(room.engine, dt, choices => startVote(room, choices));
    } catch (err) {
      console.error(`[room ${room.code}] tick error:`, err);
    }
    if (room.engine.teamWiped && room.status === 'playing') {
      room.status = 'gameover';
      io.to(room.code).emit('game:over', { door: room.engine.door, kills: room.engine.totalKills, level: room.engine.teamLevel });
      stopRoom(room);
    }
  }, dt * 1000);

  room.snapshotLoop = setInterval(() => broadcastSnapshot(room), 1000 / SNAPSHOT_RATE);
}

function startVote(room, choices) {
  const timeoutMs = VOTE_SECONDS * 1000;
  room.vote = { choices, votes: new Map(), startedAt: Date.now(), timer: null };
  io.to(room.code).emit('game:vote:start', { choices, timeoutSeconds: VOTE_SECONDS });
  room.vote.timer = setTimeout(() => resolveVote(room), timeoutMs);
}

function tallyVote(room) {
  const counts = {};
  for (const cardId of room.vote.votes.values()) counts[cardId] = (counts[cardId] || 0) + 1;
  let winner = room.vote.choices[0].id, best = -1;
  for (const choice of room.vote.choices) {
    const c = counts[choice.id] || 0;
    if (c > best) { best = c; winner = choice.id; }
  }
  // tie-break: if nobody voted at all, pick randomly among the choices
  const totalVotes = Object.values(counts).reduce((a, b) => a + b, 0);
  if (totalVotes === 0) winner = room.vote.choices[Math.floor(Math.random() * room.vote.choices.length)].id;
  return { winner, counts };
}

function resolveVote(room) {
  if (!room.vote) return;
  if (room.vote.timer) clearTimeout(room.vote.timer);
  const { winner, counts } = tallyVote(room);
  Engine.resolveUpgradeVote(room.engine, winner);
  io.to(room.code).emit('game:vote:result', { cardId: winner, counts });
  room.vote = null;
}

function broadcastSnapshot(room) {
  if (!room.engine) return;
  const e = room.engine;
  const base = {
    door: e.door, doorKills: e.doorKills, doorGoal: e.doorGoal,
    teamXp: e.teamXp, teamNextXp: e.teamNextXp, teamLevel: e.teamLevel,
    elapsed: e.elapsed, kills: e.totalKills,
    players: Object.values(e.players).map(p => ({ id: p.id, name: p.name, x: p.x, y: p.y, hp: p.hp, maxHp: p.maxHp, facing: p.facing, walkCycle: p.walkCycle, attackKick: p.attackKick, aimAngle: p.aimAngle, scarfAngle: p.scarfAngle, range: p.range, viewDist: p.viewDist, orbit: p.orbit, alive: p.alive, connected: p.connected })),
    enemies: e.enemies.map(en => ({ id: en.id, x: en.x, y: en.y, hp: en.hp, maxHp: en.maxHp, size: en.size, color: en.color, boss: en.boss, type: en.type, flash: en.flash, squish: en.squish, bobPhase: en.bobPhase, frozen: en.frozen, bleedTimer: en.bleedTimer, shieldTimer: en.shieldTimer, enrageTimer: en.enrageTimer, skillFlash: en.skillFlash })),
    projectiles: e.projectiles.map(pr => ({ x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy, size: pr.size, crit: pr.crit })),
    enemyProjectiles: e.enemyProjectiles.map(pr => ({ x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy, size: pr.size, color: pr.color })),
    shards: e.shards.map(s => ({ id: s.id, x: s.x, y: s.y })),
    chests: e.chests.map(c => ({ id: c.id, x: c.x, y: c.y, opened: c.opened })),
    bossWarnings: e.bossWarnings,
    events: e.events,
    awaitingUpgrade: e.awaitingUpgrade,
  };
  io.to(room.code).emit('game:state', base);
}

// ---------------------------------------------------------------
// Express + Socket.io wiring
// ---------------------------------------------------------------
const app = express();

app.get("/", (req, res) => {
  res.send("Block Survivor server is running");
});

app.use(express.static(path.join(__dirname, "..", "client")));

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});


io.on('connection', socket => {
  let username = null;

  socket.on('auth', ({ username: name, token }, cb) => {
    name = String(name || '').trim().slice(0, 20);
    if (!/^[A-Za-z0-9_\u0600-\u06FF]{2,20}$/.test(name)) return cb && cb({ ok: false, error: 'اسم غير صالح' });
    const user = db.users[name];
    if (user && token && user.token !== token) return cb && cb({ ok: false, error: 'الاسم محجوز بالفعل' });
    if (user && !token) return cb && cb({ ok: false, error: 'الاسم محجوز بالفعل، سجّل دخول بنفس الجهاز اللي عملت بيه الحساب' });
    const record = ensureUser(name);
    saveData();
    if (online.has(name) && online.get(name) !== socket.id) {
      const oldSocket = io.sockets.sockets.get(online.get(name));
      if (oldSocket) oldSocket.emit('auth:kicked', { reason: 'تم تسجيل الدخول من جهاز آخر' });
    }
    username = name;
    online.set(username, socket.id);
    socketUser.set(socket.id, username);
    socket.join(`user:${username}`);
    cb && cb({ ok: true, username, token: record.token });
    pushFriendList(username);
  });

  socket.on('friend:add', ({ target }) => {
    if (!username) return;
    target = String(target || '').trim();
    if (!target || target === username) return;
    if (!db.users[target]) return emitTo(username, 'error', { message: 'اللاعب ده مش موجود' });
    const me = ensureUser(username), them = ensureUser(target);
    if (me.friends.includes(target)) return;
    if (!them.incoming.includes(username)) them.incoming.push(username);
    if (!me.outgoing.includes(target)) me.outgoing.push(target);
    saveData();
    pushFriendList(username); pushFriendList(target);
    emitTo(target, 'friend:request', { from: username });
  });

  socket.on('friend:accept', ({ from }) => {
    if (!username) return;
    const me = ensureUser(username), other = ensureUser(from);
    me.incoming = me.incoming.filter(u => u !== from);
    other.outgoing = other.outgoing.filter(u => u !== username);
    if (!me.friends.includes(from)) me.friends.push(from);
    if (!other.friends.includes(username)) other.friends.push(username);
    saveData();
    pushFriendList(username); pushFriendList(from);
  });

  socket.on('friend:decline', ({ from }) => {
    if (!username) return;
    const me = ensureUser(username), other = ensureUser(from);
    me.incoming = me.incoming.filter(u => u !== from);
    other.outgoing = other.outgoing.filter(u => u !== username);
    saveData();
    pushFriendList(username); pushFriendList(from);
  });

  socket.on('friend:remove', ({ target }) => {
    if (!username) return;
    const me = ensureUser(username), other = ensureUser(target);
    me.friends = me.friends.filter(u => u !== target);
    other.friends = other.friends.filter(u => u !== username);
    saveData();
    pushFriendList(username); pushFriendList(target);
  });

  socket.on('room:create', ({ teamSizeMax }, cb) => {
    if (!username) return cb && cb({ ok: false });
    leaveRoom(username);
    const code = genRoomCode();
    const room = new Room(code, username, teamSizeMax);
    rooms.set(code, room);
    socket.join(code);
    room.broadcastLobby();
    cb && cb({ ok: true, roomCode: code });
  });

  socket.on('room:join', ({ roomCode }, cb) => {
    if (!username) return cb && cb({ ok: false, error: 'سجّل دخول الأول' });
    const room = rooms.get(String(roomCode || '').toUpperCase());
    if (!room) return cb && cb({ ok: false, error: 'الكود مش موجود' });
    if (room.status !== 'lobby') return cb && cb({ ok: false, error: 'اللعبة بدأت بالفعل' });
    if (room.members.size >= room.teamSizeMax) return cb && cb({ ok: false, error: 'الفريق مكتمل' });
    leaveRoom(username);
    room.members.set(username, { ready: false });
    socket.join(room.code);
    room.broadcastLobby();
    cb && cb({ ok: true, roomCode: room.code });
  });

  socket.on('room:invite', ({ target, roomCode }) => {
    if (!username) return;
    const room = rooms.get(roomCode);
    if (!room || !room.members.has(username)) return;
    const me = ensureUser(username);
    if (!me.friends.includes(target)) return emitTo(username, 'error', { message: 'مش صاحبك، ابعتله طلب صداقة الأول' });
    emitTo(target, 'room:invited', { from: username, roomCode: room.code, teamSizeMax: room.teamSizeMax, currentSize: room.members.size });
  });

  socket.on('room:ready', ({ ready }) => {
    if (!username) return;
    for (const room of rooms.values()) {
      if (room.members.has(username)) { room.members.get(username).ready = !!ready; room.broadcastLobby(); return; }
    }
  });

  socket.on('room:start', ({ roomCode }, cb) => {
    if (!username) return;
    const room = rooms.get(roomCode);
    if (!room || room.hostUsername !== username) return cb && cb({ ok: false, error: 'المضيف بس اللي يبدأ' });
    if (room.status !== 'lobby') return cb && cb({ ok: false });
    startGame(room);
    cb && cb({ ok: true });
  });

  socket.on('room:leave', () => { if (username) leaveRoom(username); });

  socket.on('room:restart', ({ roomCode }, cb) => {
    if (!username) return;
    const room = rooms.get(roomCode);
    if (!room || room.hostUsername !== username) return cb && cb({ ok: false, error: 'المضيف بس اللي يقدر يبدأ من جديد' });
    if (room.status !== 'gameover') return cb && cb({ ok: false });
    stopRoom(room);
    room.status = 'lobby'; room.engine = null;
    for (const m of room.members.values()) m.ready = false;
    room.broadcastLobby();
    cb && cb({ ok: true });
  });

  socket.on('game:input', input => {
    if (!username) return;
    for (const room of rooms.values()) {
      const p = room.engine && room.engine.players[username];
      if (p) {
        p.input.h = Math.max(-1, Math.min(1, Number(input.h) || 0));
        p.input.v = Math.max(-1, Math.min(1, Number(input.v) || 0));
        p.input.aiming = !!input.aiming;
        p.input.aimX = typeof input.aimX === 'number' ? input.aimX : null;
        p.input.aimY = typeof input.aimY === 'number' ? input.aimY : null;
        return;
      }
    }
  });

  socket.on('game:vote', ({ cardId }) => {
    if (!username) return;
    for (const room of rooms.values()) {
      if (room.members.has(username) && room.vote && !room.vote.votes.has(username)) {
        if (!room.vote.choices.some(c => c.id === cardId)) return;
        room.vote.votes.set(username, cardId);
        io.to(room.code).emit('game:vote:progress', { votedCount: room.vote.votes.size, totalCount: Object.values(room.engine.players).filter(p => p.connected && p.alive).length || room.members.size });
        const alivePlayers = Object.values(room.engine.players).filter(p => p.connected);
        if (room.vote.votes.size >= alivePlayers.length) resolveVote(room);
        return;
      }
    }
  });

  socket.on('disconnect', () => {
    if (!username) return;
    socketUser.delete(socket.id);
    if (online.get(username) === socket.id) online.delete(username);
    for (const room of rooms.values()) {
      const p = room.engine && room.engine.players[username];
      if (p) p.connected = false;
      if (room.members.has(username)) room.broadcastLobby();
    }
  });
});

function pushFriendList(username) {
  const u = ensureUser(username);
  emitTo(username, 'friend:list', { friends: u.friends.map(f => ({ username: f, online: online.has(f) })), incoming: u.incoming, outgoing: u.outgoing });
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Block Survivor Online listening on :${PORT}`);
});

