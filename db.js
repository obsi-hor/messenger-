import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const B2_KEY_ID = '005319007b9036c0000000001';
const B2_APP_KEY = 'K005fJFlpRRQuDtHKs1iSGm9XfbY7/o';
const B2_BUCKET = 'messenger-oksepau';
const B2_ENDPOINT = 'https://s3.us-east-005.backblazeb2.com';

export const s3 = new S3Client({
  endpoint: B2_ENDPOINT,
  region: 'us-east-005',
  credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY },
  forcePathStyle: true
});

export const BUCKET = B2_BUCKET;

const FILE_KEY = 'data.json';
let data = { users: [], codes: [], sessions: [], chats: [], messages: [], transactions: [] };
let loaded = false;
let dirty = false;
let saveTimer = null;

async function streamToString(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export async function loadData() {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: FILE_KEY }));
    const text = await streamToString(res.Body);
    data = JSON.parse(text);
    data.users = data.users || [];
    data.codes = data.codes || [];
    data.sessions = data.sessions || [];
    data.chats = data.chats || [];
    data.messages = data.messages || [];
    data.transactions = data.transactions || [];
    data.users.forEach(u => {
      if (u.hidden === undefined) u.hidden = false;
      if (u.login === undefined) u.login = null;
      if (u.passwordHash === undefined) u.passwordHash = null;
      if (u.birthday === undefined) u.birthday = null;
      if (u.bio === undefined) u.bio = '';
      if (u.lastSeen === undefined) u.lastSeen = null;
      if (u.online === undefined) u.online = false;
      if (u.showPhone === undefined) u.showPhone = 'all';
      if (u.showLastSeen === undefined) u.showLastSeen = 'all';
      if (u.showBio === undefined) u.showBio = 'all';
      if (u.showBirthday === undefined) u.showBirthday = 'all';
      if (u.oxy === undefined) u.oxy = 100;
      if (u.gifts === undefined) u.gifts = [];
    });
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      data = { users: [], codes: [], sessions: [], chats: [], messages: [], transactions: [] };
    } else {
      console.error('B2 load error:', e.message);
    }
  }
  loaded = true;
}

function markDirty() {
  if (!loaded) return;
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    if (dirty) {
      try {
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET, Key: FILE_KEY,
          Body: JSON.stringify(data, null, 2),
          ContentType: 'application/json'
        }));
        dirty = false;
      } catch (e) { console.error('B2 save error:', e.message); }
    }
    saveTimer = null;
  }, 3000);
}

export function findUserByLogin(login) {
  if (!login) return null;
  const l = login.toLowerCase().trim();
  return data.users.find(u => u.login === l) || null;
}
export function findUserById(id) {
  return data.users.find(u => u.id === id) || null;
}
export function findUserByUsername(username) {
  return data.users.find(u => u.username === username) || null;
}
export function createUser({ login, passwordHash }) {
  const id = (data.users.at(-1)?.id || 0) + 1;
  const user = {
    id, login: login.toLowerCase().trim(), passwordHash,
    username: null, name: null, bio: '', avatar: '', hidden: false,
    birthday: null, lastSeen: Date.now(), online: true,
    showPhone: 'all', showLastSeen: 'all', showBio: 'all', showBirthday: 'all',
    oxy: 100, gifts: [],
    created_at: Date.now()
  };
  data.users.push(user);
  markDirty();
  return user;
}
export function updateUser(id, patch) {
  const u = findUserById(id);
  if (!u) return null;
  Object.assign(u, patch);
  markDirty();
  return u;
}
export function setHidden(id, hidden) {
  const u = findUserById(id); if (!u) return null;
  u.hidden = !!hidden; markDirty(); return u;
}
export function removePhone(id) {
  const u = findUserById(id); if (!u) return null;
  u.phone = null; markDirty(); return u;
}
export function setOnline(id, online) {
  const u = findUserById(id); if (!u) return null;
  u.online = !!online; u.lastSeen = Date.now(); markDirty(); return u;
}

// ===== OXY =====
export function addOxy(userId, amount, reason = '') {
  const u = findUserById(userId); if (!u) return null;
  u.oxy = (u.oxy || 0) + amount;
  const tx = {
    id: (data.transactions.at(-1)?.id || 0) + 1,
    user_id: userId,
    amount,
    reason,
    ts: Date.now()
  };
  data.transactions.push(tx);
  markDirty();
  return { balance: u.oxy, tx };
}

export function getTransactions(userId, limit = 100) {
  return data.transactions
    .filter(t => t.user_id === userId)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

export function sendGift(fromId, toId, giftId, price) {
  const from = findUserById(fromId);
  const to = findUserById(toId);
  if (!from || !to) return { error: 'Пользователь не найден' };
  if ((from.oxy || 0) < price) return { error: 'Недостаточно Окси' };

  from.oxy -= price;
  to.oxy = (to.oxy || 0) + Math.floor(price * 0.5); // получателю 50%
  if (!to.gifts) to.gifts = [];
  to.gifts.push({ giftId, fromId, ts: Date.now() });

  const txFrom = {
    id: (data.transactions.at(-1)?.id || 0) + 1,
    user_id: fromId, amount: -price,
    reason: `Подарок: ${giftId}`, ts: Date.now()
  };
  data.transactions.push(txFrom);
  const txTo = {
    id: (data.transactions.at(-1)?.id || 0) + 2,
    user_id: toId, amount: Math.floor(price * 0.5),
    reason: `Получен подарок: ${giftId}`, ts: Date.now()
  };
  data.transactions.push(txTo);
  markDirty();
  return { ok: true };
}

// ===== SESSIONS =====
export function createSession(token, userId) {
  data.sessions.push({ token, user_id: userId, created_at: Date.now() });
  markDirty();
}
export function getSession(token) {
  return data.sessions.find(s => s.token === token) || null;
}
export function deleteSession(token) {
  data.sessions = data.sessions.filter(s => s.token !== token);
  markDirty();
}

// ===== CHATS =====
export function findPrivateChat(a, b) {
  return data.chats.find(c =>
    c.type === 'private' && c.members.length === 2 &&
    c.members.includes(a) && c.members.includes(b)
  ) || null;
}
export function createPrivateChat(a, b) {
  const ex = findPrivateChat(a, b);
  if (ex) return ex;
  const id = (data.chats.at(-1)?.id || 0) + 1;
  const chat = { id, type: 'private', members: [a, b], created_at: Date.now() };
  data.chats.push(chat);
  markDirty();
  return chat;
}
export function getChatById(id) {
  return data.chats.find(c => c.id === id) || null;
}
export function getUserChats(userId) {
  return data.chats
    .filter(c => c.members.includes(userId))
    .map(chat => {
      const lastMsg = [...data.messages]
        .filter(m => m.chat_id === chat.id)
        .sort((a, b) => b.created_at - a.created_at)[0] || null;
      const otherId = chat.type === 'private'
        ? chat.members.find(m => m !== userId) : null;
      const other = otherId ? findUserById(otherId) : null;
      const unread = data.messages.filter(m =>
        m.chat_id === chat.id && m.from_user !== userId &&
        !(m.read_by || []).includes(userId)
      ).length;
      return {
        id: chat.id, type: chat.type,
        other: other ? {
          id: other.id, name: other.name, username: other.username,
          avatar: other.avatar, online: !!other.online, lastSeen: other.lastSeen
        } : null,
        last: lastMsg ? {
          text: lastMsg.text || (lastMsg.image ? '📷 Фото' : ''),
          ts: lastMsg.created_at, from: lastMsg.from_user
        } : null,
        unread
      };
    })
    .sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));
}

export function createMessage(chatId, fromUser, text, image = null) {
  const id = (data.messages.at(-1)?.id || 0) + 1;
  const msg = {
    id, chat_id: chatId, from_user: fromUser,
    text: text || '', image: image || null,
    read_by: [fromUser], created_at: Date.now()
  };
  data.messages.push(msg);
  markDirty();
  return msg;
}
export function getChatMessages(chatId, limit = 100) {
  return data.messages
    .filter(m => m.chat_id === chatId)
    .sort((a, b) => a.created_at - b.created_at)
    .slice(-limit);
}
export function isChatMember(chatId, userId) {
  const chat = getChatById(chatId);
  return chat && chat.members.includes(userId);
}
export function markChatRead(chatId, userId) {
  let changed = 0;
  data.messages.forEach(m => {
    if (m.chat_id === chatId && m.from_user !== userId) {
      if (!m.read_by) m.read_by = [m.from_user];
      if (!m.read_by.includes(userId)) { m.read_by.push(userId); changed++; }
    }
  });
  if (changed) markDirty();
  return changed;
  }
