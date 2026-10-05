import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const B2_KEY_ID = process.env.B2_KEY_ID || '005319007b9036c0000000001';
const B2_APP_KEY = process.env.B2_APP_KEY || 'ВСТАВЬ_applicationKey';
const B2_BUCKET = process.env.B2_BUCKET || 'messenger-oksepau';
const B2_ENDPOINT = process.env.B2_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com';

const CREATOR_LOGIN = 'oksepau';

export const s3 = new S3Client({
  endpoint: B2_ENDPOINT, region: 'us-east-005',
  credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY },
  forcePathStyle: true
});
export const BUCKET = B2_BUCKET;

const FILE_KEY = 'data.json';

let data = {
  users: [], sessions: [], chats: [], messages: [],
  transactions: [], registrations: [], blocks: [],
  contacts: [], posts: [], channels: [], nextNftNumber: 1
};
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
    data.sessions = data.sessions || [];
    data.chats = data.chats || [];
    data.messages = data.messages || [];
    data.transactions = data.transactions || [];
    data.registrations = data.registrations || [];
    data.blocks = data.blocks || [];
    data.contacts = data.contacts || [];
    data.posts = data.posts || [];
    data.channels = data.channels || [];
    if (!data.nextNftNumber) data.nextNftNumber = 1;

    // Чистим всех кроме создателя
    const creator = data.users.find(u => u.login === CREATOR_LOGIN);
    if (creator) {
      const keepId = creator.id;
      data.users = [creator];
      data.chats = [];
      data.messages = [];
      data.transactions = data.transactions.filter(t => t.user_id === keepId);
      data.contacts = [];
      data.blocks = [];
      data.channels = [];
      data.posts = [];
      data.sessions = data.sessions.filter(s => s.user_id === keepId);
      creator.isAdmin = true;
      creator.isCreator = true;
      creator.oxy = 999999999;
      if (!creator.nfts) creator.nfts = [];
      if (!creator.gifts) creator.gifts = [];
      if (!creator.profileNft) creator.profileNft = null;
    }

    // Миграция
    data.users.forEach(u => {
      if (u.hidden === undefined) u.hidden = false;
      if (u.bio === undefined) u.bio = '';
      if (u.avatar === undefined) u.avatar = '';
      if (u.oxy === undefined) u.oxy = 0;
      if (u.gifts === undefined) u.gifts = [];
      if (u.nfts === undefined) u.nfts = [];
      if (u.profileNft === undefined) u.profileNft = null;
      if (u.extraUsernames === undefined) u.extraUsernames = [];
      if (u.isAdmin === undefined) u.isAdmin = false;
      if (u.isCreator === undefined) u.isCreator = false;
      if (u.birthday === undefined) u.birthday = null;
      if (u.twofaPassword === undefined) u.twofaPassword = null;
      if (u.twofaWord === undefined) u.twofaWord = null;
      if (u.showLogin === undefined) u.showLogin = 'all';
      if (u.showLastSeen === undefined) u.showLastSeen = 'all';
      if (u.showBio === undefined) u.showBio = 'all';
      if (u.showBirthday === undefined) u.showBirthday = 'all';
    });
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      data = { users: [], sessions: [], chats: [], messages: [], transactions: [], registrations: [], blocks: [], contacts: [], posts: [], channels: [], nextNftNumber: 1 };
    } else console.error('B2 load error:', e.message);
  }
  loaded = true;
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
export function createUser({ login, passwordHash }) {
  const id = (data.users.at(-1)?.id || 0) + 1;
  const user = {
    id, login: login.toLowerCase().trim(), passwordHash,
    username: null, extraUsernames: [], name: null,
    bio: '', avatar: '', birthday: null,
    lastSeen: Date.now(), online: true,
    showLogin: 'all', showLastSeen: 'all', showBio: 'all', showBirthday: 'all',
    oxy: 0, gifts: [], nfts: [], profileNft: null,
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

// ===== ORDINARY GIFTS =====
const GIFT_PRICES = { pistol: 25, car: 50, heart: 15, bday: 20 };

export function sendGift(fromId, toId, giftId, price) {
  const from = findUserById(fromId);
  const to = findUserById(toId);
  if (!from || !to) return { error: 'Не найден' };
  if ((from.oxy || 0) < price) return { error: 'Недостаточно Окси' };
  from.oxy -= price;
  if (!to.gifts) to.gifts = [];
  to.gifts.push({ giftId, fromId, ts: Date.now() });
  data.transactions.push({
    id: (data.transactions.at(-1)?.id || 0) + 1,
    user_id: fromId, amount: -price, reason: 'Подарок: ' + giftId, ts: Date.now()
  });
  markDirty();
  return { ok: true };
}

export function sellGift(userId, giftIndex) {
  const u = findUserById(userId);
  if (!u || !u.gifts || !u.gifts[giftIndex]) return { error: 'Не найден' };
  const gift = u.gifts[giftIndex];
  const base = GIFT_PRICES[gift.giftId] || 10;
  const commission = Math.ceil(base * 0.05);
  const payout = base - commission;
  u.gifts.splice(giftIndex, 1);
  u.oxy = (u.oxy || 0) + payout;
  data.transactions.push({
    id: (data.transactions.at(-1)?.id || 0) + 1,
    user_id: userId, amount: payout,
    reason: 'Продажа подарка (комиссия ' + commission + ')', ts: Date.now()
  });
  markDirty();
  return { ok: true, payout, commission, balance: u.oxy };
}

// ===== NFT =====
const NFT_PRICES = { rose: 1500, orb: 1000, slime: 2000 };

export function buyNft(userId, nftType) {
  const u = findUserById(userId);
  if (!u) return { error: 'Пользователь не найден' };
  const price = NFT_PRICES[nftType];
  if (!price) return { error: 'Неверный тип NFT' };
  if ((u.oxy || 0) < price) return { error: 'Недостаточно Окси' };
  u.oxy -= price;
  const number = data.nextNftNumber;
  data.nextNftNumber = number + 1;
  const nft = {
    id: 'nft_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    type: nftType, number: number, ownerId: userId, boughtAt: Date.now()
  };
  if (!u.nfts) u.nfts = [];
  u.nfts.push(nft);
  data.transactions.push({
    id: (data.transactions.at(-1)?.id || 0) + 1,
    user_id: userId, amount: -price,
    reason: 'Куплено NFT #' + number, ts: Date.now()
  });
  markDirty();
  return { ok: true, nft: nft, balance: u.oxy };
}

export function sellNft(userId, nftId) {
  const u = findUserById(userId);
  if (!u || !u.nfts) return { error: 'Не найден' };
  const idx = u.nfts.findIndex(n => n.id === nftId);
  if (idx === -1) return { error: 'NFT не найден' };
  const nft = u.nfts[idx];
  const base = NFT_PRICES[nft.type] || 0;
  const commission = Math.ceil(base * 0.05);
  const payout = base - commission;
  u.nfts.splice(idx, 1);
  u.oxy = (u.oxy || 0) + payout;
  if (u.profileNft === nftId) u.profileNft = null;
  data.transactions.push({
    id: (data.transactions.at(-1)?.id || 0) + 1,
    user_id: userId, amount: payout,
    reason: 'Продажа NFT #' + nft.number + ' (комиссия ' + commission + ')', ts: Date.now()
  });
  markDirty();
  return { ok: true, payout, commission, balance: u.oxy };
}

export function setProfileNft(userId, nftId) {
  const u = findUserById(userId);
  if (!u || !u.nfts) return { error: 'Не найден' };
  if (nftId === null) { u.profileNft = null; markDirty(); return { ok: true }; }
  const nft = u.nfts.find(n => n.id === nftId);
  if (!nft) return { error: 'NFT не найден' };
  u.profileNft = nftId;
  markDirty();
  return { ok: true };
}

export function giveNft(fromId, toId, nftId) {
  const from = findUserById(fromId);
  const to = findUserById(toId);
  if (!from || !to) return { error: 'Не найден' };
  if (!from.nfts) return { error: 'Нет NFT' };
  const idx = from.nfts.findIndex(n => n.id === nftId);
  if (idx === -1) return { error: 'NFT не найден' };
  const nft = from.nfts[idx];
  from.nfts.splice(idx, 1);
  nft.ownerId = toId;
  if (!to.nfts) to.nfts = [];
  to.nfts.push(nft);
  if (from.profileNft === nftId) from.profileNft = null;
  markDirty();
  return { ok: true, nft: nft };
}

export function getNftPrices() { return NFT_PRICES; }

// ===== EXTRA USERNAMES =====
const USERNAME_PRICES = [0, 50, 100, 150, 200, 300];

export function usernameExists(username) {
  if (!username) return false;
  const u = username.toLowerCase().trim();
  return data.users.some(x =>
    x.username === u || (x.extraUsernames || []).includes(u)
  );
}

export function buyExtraUsername(userId, username) {
  const u = findUserById(userId);
  if (!u) return { error: 'Пользователь не найден' };
  const un = username.toLowerCase().trim();
  if (!/^[a-z0-9_]{5,16}$/.test(un)) return { error: 'Юзернейм: 5–16, латиница, цифры, _' };
  const extra = u.extraUsernames || [];
  if (extra.length >= 5) return { error: 'Максимум 5 дополнительных юзернеймов' };
  if (usernameExists(un) || u.username === un) return { error: 'Юзернейм занят' };
  const price = USERNAME_PRICES[extra.length + 1] || 300;
  if ((u.oxy || 0) < price) return { error: 'Нужно ' + price + ' Окси' };
  u.oxy -= price;
  extra.push(un);
  u.extraUsernames = extra;
  data.transactions.push({
    id: (data.transactions.at(-1)?.id || 0) + 1,
    user_id: userId, amount: -price,
    reason: 'Покупка юзернейма @' + un, ts: Date.now()
  });
  markDirty();
  return { ok: true, username: un, price, balance: u.oxy };
}
export function getUsernamePrice(count) { return USERNAME_PRICES[count] || 300; }

// ===== 2FA =====
export function set2FA(userId, password, word) {
  const u = findUserById(userId); if (!u) return null;
  u.twofaPassword = password;
  u.twofaWord = word;
  markDirty();
  return u;
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
    .filter(c => c.members.includes(userId) || (c.type === 'channel' && c.ownerId === userId))
    .map(chat => {
      const clearedAt = (chat.clearedBy || {})[userId] || 0;
      const msgs = data.messages.filter(m => m.chat_id === chat.id && m.created_at > clearedAt);
      const lastMsg = [...msgs].sort((a, b) => b.created_at - a.created_at)[0] || null;
      var other = null;
      if (chat.type === 'private') {
        const otherId = chat.members.find(m => m !== userId);
        other = otherId ? findUserById(otherId) : null;
      }
      const unread = msgs.filter(m => m.from_user !== userId && !(m.read_by || []).includes(userId)).length;
      return {
        id: chat.id, type: chat.type,
        title: chat.title || null,
        username: chat.username || null,
        avatar: chat.avatar || null,
        ownerId: chat.ownerId || null,
        subscribersCount: chat.subscribers ? chat.subscribers.length : 0,
        isMember: chat.members ? chat.members.includes(userId) : false,
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
export function createMessage(chatId, fromUser, text, image = null, replyTo = null, extra = null) {
  const id = (data.messages.at(-1)?.id || 0) + 1;
  const msg = {
    id, chat_id: chatId, from_user: fromUser,
    text: text || '', image: image || null, reply_to: replyTo,
    read_by: [fromUser], created_at: Date.now()
  };
  if (extra) Object.assign(msg, extra);
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
  if (!chat) return false;
  if (chat.type === 'channel') return chat.ownerId === userId;
  return chat.members.includes(userId);
}
export function canWriteToChat(chatId, userId) {
  const chat = getChatById(chatId);
  if (!chat) return false;
  if (chat.type === 'channel') return chat.ownerId === userId;
  return chat.members.includes(userId);
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

// ===== CLEAR CHAT =====
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
export function getBlockedIds(userId) {
  return data.blocks.filter(b => b.userId === userId).map(b => b.blockedId);
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
  return data.contacts.filter(c => c.userId === userId).map(c => {
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

// ===== POSTS =====
export function createPost(userId, image, text) {
  const id = (data.posts.at(-1)?.id || 0) + 1;
  const post = { id, user_id: userId, image: image || null, text: text || '', ts: Date.now() };
  data.posts.push(post);
  markDirty();
  return post;
}
export function getPosts(userId, limit = 50) {
  return data.posts.filter(p => p.user_id === userId).sort((a, b) => b.ts - a.ts).slice(0, limit);
}
export function deletePost(postId, userId) {
  const p = data.posts.find(x => x.id === postId);
  if (!p) return { error: 'Не найдено' };
  if (p.user_id !== userId) return { error: 'Нельзя' };
  data.posts = data.posts.filter(x => x.id !== postId);
  markDirty();
  return { ok: true };
}

// ===== CHANNELS =====
export function createChannel(ownerId, title, username, description) {
  if (!title) return { error: 'Введите название' };
  if (username) {
    const u = username.toLowerCase().trim();
    if (!/^[a-z0-9_]{5,32}$/.test(u)) return { error: 'Юзернейм канала: 5–32, латиница, цифры, _' };
    if (data.channels.some(c => c.username === u)) return { error: 'Такой канал уже есть' };
  }
  const id = (data.chats.at(-1)?.id || 0) + 1;
  const chat = {
    id, type: 'channel',
    title: title.trim().slice(0, 100),
    username: username ? username.toLowerCase().trim() : null,
    description: (description || '').trim().slice(0, 200),
    avatar: null,
    ownerId,
    members: [ownerId],
    subscribers: [ownerId],
    created_at: Date.now(),
    clearedBy: {}
  };
  data.chats.push(chat);
  markDirty();
  return { ok: true, chatId: id, channel: chat };
}

export function subscribeToChannel(chatId, userId) {
  const chat = getChatById(chatId);
  if (!chat || chat.type !== 'channel') return { error: 'Канал не найден' };
  if (!chat.subscribers) chat.subscribers = [];
  if (!chat.members) chat.members = [];
  if (!chat.subscribers.includes(userId)) {
    chat.subscribers.push(userId);
    chat.members.push(userId);
    markDirty();
  }
  return { ok: true };
}

export function unsubscribeFromChannel(chatId, userId) {
  const chat = getChatById(chatId);
  if (!chat || chat.type !== 'channel') return { error: 'Канал не найден' };
  if (chat.ownerId === userId) return { error: 'Создатель не может отписаться' };
  chat.subscribers = (chat.subscribers || []).filter(id => id !== userId);
  chat.members = (chat.members || []).filter(id => id !== userId);
  markDirty();
  return { ok: true };
}

export function findChannelByUsername(username) {
  if (!username) return null;
  const u = username.toLowerCase().trim();
  return data.channels.find(c => c.username === u) || null;
}

// ===== REGISTRATION IP LIMIT =====
export function getIpRegistrations(ip) {
  return data.registrations.filter(r => r.ip === ip);
}
export function addIpRegistration(ip, userId) {
  data.registrations.push({ ip, user_id: userId, ts: Date.now() });
  markDirty();
}
