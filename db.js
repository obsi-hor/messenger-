
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const B2_KEY_ID = process.env.B2_KEY_ID || '005319007b9036c0000000001';
const B2_APP_KEY = process.env.B2_APP_KEY || 'ВСТАВЬ_applicationKey';
const B2_BUCKET = process.env.B2_BUCKET || 'messenger-oksepau';
const B2_ENDPOINT = process.env.B2_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com';

const CREATOR_LOGIN = 'oksepau'; // ← ТВОЙ ЛОГИН

export const s3 = new S3Client({
  endpoint: B2_ENDPOINT, region: 'us-east-005',
  credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY },
  forcePathStyle: true
});
export const BUCKET = B2_BUCKET;

const FILE_KEY = 'data.json';
let data = { users: [], codes: [], sessions: [], chats: [], messages: [], transactions: [], registrations: [], blocks: [], contacts: [], posts: [] };
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
    data.registrations = data.registrations || [];
    data.blocks = data.blocks || [];
    data.contacts = data.contacts || [];
    data.posts = data.posts || [];

    // ===== УДАЛЯЕМ ВСЕХ, КРОМЕ СОЗДАТЕЛЯ =====
    const creator = data.users.find(u => u.login === CREATOR_LOGIN);
    if (creator) {
      const keepId = creator.id;
      data.users = [creator];
      data.chats = data.chats.filter(c => c.members.includes(keepId) && c.members.every(m => m === keepId));
      data.messages = data.messages.filter(m => {
        const chat = data.chats.find(c => c.id === m.chat_id);
        return !!chat;
      });
      data.transactions = data.transactions.filter(t => t.user_id === keepId);
      data.contacts = data.contacts.filter(c => c.userId === keepId);
      data.blocks = [];
      data.sessions = data.sessions.filter(s => s.user_id === keepId);

      // даём админа и создателя
      creator.isAdmin = true;
      creator.isCreator = true;
      creator.oxy = 999999999;
      if (creator.bio && creator.bio.length > 100) {
        creator.bio = creator.bio.slice(0, 100);
      }
    } else {
      // создателя нет — очищаем всех
      data.users = [];
      data.chats = [];
      data.messages = [];
      data.transactions = [];
      data.contacts = [];
      data.blocks = [];
    }

    // миграция оставшихся
    data.users.forEach(u => {
      if (u.hidden === undefined) u.hidden = false;
      if (u.bio === undefined) u.bio = '';
      if (u.avatar === undefined) u.avatar = '';
      if (u.oxy === undefined) u.oxy = 0;
      if (u.gifts === undefined) u.gifts = [];
      if (u.extraUsernames === undefined) u.extraUsernames = [];
      if (u.isAdmin === undefined) u.isAdmin = false;
      if (u.isCreator === undefined) u.isCreator = false;
    });
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      data = { users: [], codes: [], sessions: [], chats: [], messages: [], transactions: [], registrations: [], blocks: [], contacts: [], posts: [] };
    } else console.error('B2 load error:', e.message);
  }
  loaded = true;
  // принудительно сохраняем очищенную базу
  markDirty();
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

// ===== USERS =====
export function findUserByLogin(login) {
  if (!login) return null;
  const l = login.toLowerCase().trim();
  return data.users.find(u => u.login === l) || null;
}
export function findUserById(id) {
  return data.users.find(u => u.id === id) || null;
}
export function findUserByUsername(username) {
  if (!username) return null;
  const u = username.toLowerCase().trim();
  return data.users.find(x =>
    x.username === u || (x.extraUsernames || []).includes(u)
  ) || null;
}
export function usernameExists(username) {
  if (!username) return false;
  const u = username.toLowerCase().trim();
  return data.users.some(x =>
    x.username === u || (x.extraUsernames || []).includes(u)
  );
}
export function createUser({ login, passwordHash }) {
  const id = (data.users.at(-1)?.id || 0) + 1;
  const user = {
    id, login: login.toLowerCase().trim(), passwordHash,
    username: null, extraUsernames: [], name: null, bio: '', avatar: '', hidden: false,
    birthday: null, lastSeen: Date.now(), online: true,
    showPhone: 'all', showLastSeen: 'all', showBio: 'all', showBirthday: 'all',
    oxy: 0, gifts: [],
    twofaPassword: null, twofaWord: null,
    isAdmin: false, isCreator: false,
    created_at: Date.now()
  };
  data.users.push(user);
  markDirty();
  return user;
}
export function updateUser(id, patch) {
  const u = findUserById(id); if (!u) return null;
  Object.assign(u, patch); markDirty(); return u;
}
export function setHidden(id, hidden) {
  const u = findUserById(id); if (!u) return null;
  u.hidden = !!hidden; markDirty(); return u;
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
    user_id: userId, amount, reason, ts: Date.now()
  };
  data.transactions.push(tx);
  markDirty();
  return { balance: u.oxy, tx };
}
export function getTransactions(userId, limit = 100) {
  return data.transactions.filter(t => t.user_id === userId).sort((a, b) => b.ts - a.ts).slice(0, limit);
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
  return data.chats.find(c => c.type === 'private' && c.members.length === 2 && c.members.includes(a) && c.members.includes(b)) || null;
}
export function createPrivateChat(a, b) {
  const ex = findPrivateChat(a, b);
  if (ex) return ex;
  const id = (data.chats.at(-1)?.id || 0) + 1;
  const chat = { id, type: 'private', members: [a, b], created_at: Date.now(), clearedBy: {} };
  data.chats.push(chat);
  markDirty();
  return chat;
}
export function getChatById(id) { return data.chats.find(c => c.id === id) || null; }
export function getUserChats(userId) {
  return data.chats
    .filter(c => c.members.includes(userId))
    .map(chat => {
      const clearedAt = (chat.clearedBy || {})[userId] || 0;
      const msgs = data.messages.filter(m => m.chat_id === chat.id && m.created_at > clearedAt);
      const lastMsg = [...msgs].sort((a, b) => b.created_at - a.created_at)[0] || null;
      const otherId = chat.type === 'private' ? chat.members.find(m => m !== userId) : null;
      const other = otherId ? findUserById(otherId) : null;
      const unread = msgs.filter(m => m.from_user !== userId && !(m.read_by || []).includes(userId)).length;
      return {
        id: chat.id, type: chat.type,
        other: other ? {
          id: other.id, name: other.name, username: other.username, avatar: other.avatar,
          online: !!other.online, lastSeen: other.lastSeen, isCreator: !!other.isCreator
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

// ===== MESSAGES =====
export function createMessage(chatId, fromUser, text, image = null, replyTo = null) {
  const id = (data.messages.at(-1)?.id || 0) + 1;
  const msg = {
    id, chat_id: chatId, from_user: fromUser,
    text: text || '', image: image || null, reply_to: replyTo,
    read_by: [fromUser], created_at: Date.now()
  };
  data.messages.push(msg);
  markDirty();
  return msg;
}
export function getChatMessages(chatId, userId, limit = 200) {
  const chat = getChatById(chatId);
  const clearedAt = (chat?.clearedBy || {})[userId] || 0;
  return data.messages
    .filter(m => m.chat_id === chatId && m.created_at > clearedAt)
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
