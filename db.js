import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const B2_KEY_ID = process.env.B2_KEY_ID || '005319007b9036c0000000001';
const B2_APP_KEY = process.env.B2_APP_KEY || 'ВСТАВЬ_applicationKey';
const B2_BUCKET = process.env.B2_BUCKET || 'messenger-oksepau';
const B2_ENDPOINT = process.env.B2_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com';

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
    data.users.forEach((u, i) => {
      if (u.hidden === undefined) u.hidden = false;
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
      if (u.extraUsernames === undefined) u.extraUsernames = [];
      if (u.twofaPassword === undefined) u.twofaPassword = null;
      if (u.twofaWord === undefined) u.twofaWord = null;
      if (u.isAdmin === undefined) u.isAdmin = false;
      if (u.isCreator === undefined) u.isCreator = false;
    });
    // первый пользователь = создатель
    if (data.users[0]) {
      if (!data.users[0].isCreator) { data.users[0].isCreator = true; data.users[0].isAdmin = true; }
    }
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      data = { users: [], codes: [], sessions: [], chats: [], messages: [], transactions: [], registrations: [], blocks: [], contacts: [], posts: [] };
    } else console.error('B2 load error:', e.message);
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

// ===== USERS =====
export function findUserByLogin(login) {
  if (!login) return null;
  const l = login.toLowerCase().trim();
  return data.users.find(u => u.login === l) || null;
}
export function findUserById(id) { return data.users.find(u => u.id === id) || null; }

export function findUserByAnyUsername(username) {
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
    oxy: 100, gifts: [],
    twofaPassword: null, twofaWord: null,
    isAdmin: id === 1, isCreator: id === 1,
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

// ===== REGISTRATION IP LIMIT =====
export function getIpRegistrations(ip) {
  return data.registrations.filter(r => r.ip === ip);
}
export function addIpRegistration(ip, userId) {
  data.registrations.push({ ip, user_id: userId, ts: Date.now() });
  markDirty();
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

// ===== GIFTS =====
const GIFT_PRICES = { pistol: 25, car: 50, heart: 15, bday: 20 };

export function sendGift(fromId, toId, giftId, price) {
  const from = findUserById(fromId);
  const to = findUserById(toId);
  if (!from || !to) return { error: 'Пользователь не найден' };
  if ((from.oxy || 0) < price) return { error: 'Недостаточно Окси' };
  from.oxy -= price;
  if (!to.gifts) to.gifts = [];
  to.gifts.push({ giftId, fromId, ts: Date.now() });
  const tx = {
    id: (data.transactions.at(-1)?.id || 0) + 1,
    user_id: fromId, amount: -price, reason: `Подарок: ${giftId}`, ts: Date.now()
  };
  data.transactions.push(tx);
  markDirty();
  return { ok: true };
}

export function sellGift(userId, giftIndex) {
  const u = findUserById(userId);
  if (!u) return { error: 'Пользователь не найден' };
  if (!u.gifts || !u.gifts[giftIndex]) return { error: 'Подарок не найден' };
  const gift = u.gifts[giftIndex];
  const basePrice = GIFT_PRICES[gift.giftId] || 10;
  const commission = Math.ceil(basePrice * 0.05);
  const payout = basePrice - commission;
  u.gifts.splice(giftIndex, 1);
  u.oxy = (u.oxy || 0) + payout;
  const tx = {
    id: (data.transactions.at(-1)?.id || 0) + 1,
    user_id: userId, amount: payout,
    reason: `Продажа подарка: ${gift.giftId} (комиссия ${commission} 🔮)`,
    ts: Date.now()
  };
  data.transactions.push(tx);
  markDirty();
  return { ok: true, payout, commission, balance: u.oxy };
}

// ===== USERNAMES =====
const USERNAME_PRICES = [0, 50, 100, 150, 200, 300]; // индекс = сколько уже куплено доп

export function buyExtraUsername(userId, username) {
  const u = findUserById(userId);
  if (!u) return { error: 'Пользователь не найден' };
  const un = username.toLowerCase().trim();
  if (!/^[a-z0-9_]{5,16}$/.test(un)) return { error: 'Юзернейм: 5–16, латиница, цифры, _' };
  const extra = u.extraUsernames || [];
  if (extra.length >= 5) return { error: 'Максимум 5 дополнительных юзернеймов' };
  if (usernameExists(un) || u.username === un) return { error: 'Юзернейм занят' };
  const price = USERNAME_PRICES[extra.length + 1] || 300;
  if ((u.oxy || 0) < price) return { error: `Нужно ${price} Окси` };

  u.oxy -= price;
  extra.push(un);
  u.extraUsernames = extra;

  const tx = {
    id: (data.transactions.at(-1)?.id || 0) + 1,
    user_id: userId, amount: -price,
    reason: `Покупка юзернейма @${un}`, ts: Date.now()
  };
  data.transactions.push(tx);
  markDirty();
  return { ok: true, username: un, price, balance: u.oxy };
}

export function getUsernamePrice(count) {
  return USERNAME_PRICES[count] || 300;
}

// ===== 2FA =====
export function set2FA(userId, password, word) {
  const u = findUserById(userId); if (!u) return null;
  u.twofaPassword = password;
  u.twofaWord = word;
  markDirty();
  return u;
}

// ===== SESSIONS =====
export function createSession(token, userId) {
  data.sessions.push({ token, user_id: userId, created_at: Date.now() });
  markDirty();
}
export function getSession(token) { return data.sessions.find(s => s.token === token) || null; }
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

export function clearChatForUser(chatId, userId) {
  const chat = getChatById(chatId);
  if (!chat) return false;
  if (!chat.clearedBy) chat.clearedBy = {};
  chat.clearedBy[userId] = Date.now();
  markDirty();
  return true;
}

export function clearChatForAll(chatId) {
  data.messages = data.messages.filter(m => m.chat_id !== chatId);
  markDirty();
  return true;
}

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
      const blockedByMe = data.blocks.some(b => b.userId === userId && b.blockedId === otherId);
      return {
        id: chat.id, type: chat.type,
        other: other ? {
          id: other.id, name: other.name, username: other.username, avatar: other.avatar,
          online: !!other.online, lastSeen: other.lastSeen,
          isCreator: !!other.isCreator
        } : null,
        last: lastMsg ? {
          text: lastMsg.text || (lastMsg.image ? '📷 Фото' : ''),
          ts: lastMsg.created_at, from: lastMsg.from_user
        } : null,
        unread, blockedByMe
      };
    })
    .sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));
}

// ===== BLOCKS =====
export function blockUser(userId, blockedId) {
  if (userId === blockedId) return { error: 'Нельзя себя' };
  if (data.blocks.some(b => b.userId === userId && b.blockedId === blockedId)) return { ok: true };
  data.blocks.push({ userId, blockedId, ts: Date.now() });
  markDirty();
  return { ok: true };
}
export function unblockUser(userId, blockedId) {
  data.blocks = data.blocks.filter(b => !(b.userId === userId && b.blockedId === blockedId));
  markDirty();
  return { ok: true };
}
export function isBlocked(fromId, toId) {
  return data.blocks.some(b => b.userId === toId && b.blockedId === fromId);
}

// ===== MESSAGES =====
export function createMessage(chatId, fromUser, text, image = null, replyTo = null) {
  const id = (data.messages.at(-1)?.id || 0) + 1;
  const msg = {
    id, chat_id: chatId, from_user: fromUser,
    text: text || '', image: image || null,
    reply_to: replyTo,
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
export function getMessageById(id) {
  return data.messages.find(m => m.id === id) || null;
}

// ===== CONTACTS =====
export function addContact(userId, contactId) {
  if (userId === contactId) return { error: 'Нельзя себя' };
  if (data.contacts.some(c => c.userId === userId && c.contactId === contactId)) return { ok: true };
  data.contacts.push({ userId, contactId, ts: Date.now() });
  markDirty();
  return { ok: true };
}
export function removeContact(userId, contactId) {
  data.contacts = data.contacts.filter(c => !(c.userId === userId && c.contactId === contactId));
  markDirty();
  return { ok: true };
}
export function getContacts(userId) {
  const list = data.contacts.filter(c => c.userId === userId);
  return list.map(c => {
    const u = findUserById(c.contactId);
    if (!u) return null;
    return {
      id: u.id, name: u.name, username: u.username, avatar: u.avatar,
      online: !!u.online, lastSeen: u.lastSeen, isCreator: !!u.isCreator
    };
  }).filter(Boolean);
}
export function isContact(userId, contactId) {
  return data.contacts.some(c => c.userId === userId && c.contactId === contactId);
}

// ===== POSTS (публикации) =====
export function createPost(userId, image, text) {
  const id = (data.posts.at(-1)?.id || 0) + 1;
  const post = {
    id, user_id: userId, image: image || null,
    text: text || '', ts: Date.now()
  };
  data.posts.push(post);
  markDirty();
  return post;
}
export function getPosts(userId, limit = 50) {
  return data.posts
    .filter(p => p.user_id === userId)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}
export function deletePost(postId, userId) {
  const p = data.posts.find(x => x.id === postId);
  if (!p) return { error: 'Не найдено' };
  if (p.user_id !== userId) return { error: 'Нельзя' };
  data.posts = data.posts.filter(x => x.id !== postId);
  markDirty();
  return { ok: true };
      }
