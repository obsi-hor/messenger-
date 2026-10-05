import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import * as db from './db.js';
import { s3, BUCKET, loadData } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml'
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(r => {
    let d=''; req.on('data',c=>d+=c);
    req.on('end',()=>{ try{r(JSON.parse(d||'{}'))}catch{r({})} });
  });
}
function readRaw(req, limit=20*1024*1024) {
  return new Promise((resolve, reject) => {
    const chunks=[]; let size=0;
    req.on('data',c=>{ size+=c.length; if(size>limit){reject(new Error('big'));req.destroy();return;} chunks.push(c); });
    req.on('end',()=>resolve(Buffer.concat(chunks)));
    req.on('error',reject);
  });
}
function genToken(){ return crypto.randomBytes(32).toString('hex'); }
function hashPwd(p){
  const s=crypto.randomBytes(16).toString('hex');
  return s+':'+crypto.scryptSync(p,s,64).toString('hex');
}
function verifyPwd(p,stored){
  if(!stored)return false;
  const [s,h]=stored.split(':');
  return crypto.scryptSync(p,s,64).toString('hex')===h;
}
function getUser(req){
  const t=(req.headers.authorization||'').replace('Bearer ','');
  const s=db.getSession(t); if(!s)return null;
  return db.findUserById(s.user_id);
}
function detectExt(buf){
  if(buf[0]===0xFF&&buf[1]===0xD8)return '.jpg';
  if(buf[0]===0x89&&buf[1]===0x50)return '.png';
  if(buf[0]===0x52&&buf[1]===0x49)return '.webp';
  if(buf[0]===0x47&&buf[1]===0x49)return '.gif';
  return null;
}
function publicUser(u){
  return {
    id:u.id, login:u.login, phone:u.phone, username:u.username,
    extraUsernames:u.extraUsernames||[],
    name:u.name, bio:u.bio, avatar:u.avatar,
    birthday:u.birthday, oxy:u.oxy||0, gifts:u.gifts||[],
    nfts:u.nfts||[], profileNft:u.profileNft||null,
    isAdmin:!!u.isAdmin, isCreator:!!u.isCreator,
    showPhone:u.showPhone, showLastSeen:u.showLastSeen,
    showBio:u.showBio, showBirthday:u.showBirthday
  };
}
function getClientIp(req){
  const xff = req.headers['x-forwarded-for'];
  if(xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function serveStatic(req,res){
  let url=req.url.split('?')[0];
  if(url==='/')url='/login.html';
  const full=path.join(__dirname,'public',url);
  fs.readFile(full,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not Found');return;}
    const ext=path.extname(full);
    res.writeHead(200,{'Content-Type':MIME[ext]||'text/plain'});
    res.end(data);
  });
}

async function uploadToB2(buf, key, mime){
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: mime }));
}

async function serveB2(req,res,key){
  try{
    const out=await s3.send(new GetObjectCommand({Bucket:BUCKET,Key:key}));
    const chunks=[]; for await(const c of out.Body) chunks.push(c);
    const ext=path.extname(key).toLowerCase();
    res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream'});
    res.end(Buffer.concat(chunks));
  }catch{ res.writeHead(404); res.end('Not Found'); }
}

// ===== AUTH =====
async function apiRegister(req,res){
  const ip = getClientIp(req);
  const ipRegs = db.getIpRegistrations(ip);
  if (ipRegs.length >= 2) {
    return json(res, 403, { error: 'С этого IP уже зарегистрировано 2 аккаунта' });
  }
  const b=await readBody(req);
  const login=String(b.login||'').trim().toLowerCase();
  const password=String(b.password||'');
  const name=String(b.name||'').trim().slice(0,64);
  const username=String(b.username||'').trim().toLowerCase();
  if(!/^[a-z0-9_]{3,20}$/.test(login))return json(res,400,{error:'Логин: 3–20, латиница, цифры, _'});
  if(password.length<4)return json(res,400,{error:'Пароль минимум 4 символа'});
  if(!/^[a-z0-9_]{5,16}$/.test(username))return json(res,400,{error:'Юзернейм: 5–16, латиница, цифры, _'});
  if(db.findUserByLogin(login))return json(res,400,{error:'Логин занят'});
  if(db.usernameExists && db.usernameExists(username))return json(res,400,{error:'Юзернейм занят'});
  if(!name)return json(res,400,{error:'Введите имя'});

  const user=db.createUser({login,passwordHash:hashPwd(password)});
  db.updateUser(user.id,{name: name, username: username});
  db.setOnline(user.id,true);
  db.addIpRegistration(ip, user.id);
  const token=genToken();
  db.createSession(token,user.id);
  json(res,200,{ok:true,token,isNew:true,user:publicUser(user)});
}

async function apiLogin(req,res){
  const b=await readBody(req);
  const login=String(b.login||'').trim().toLowerCase();
  const password=String(b.password||'');
  const user=db.findUserByLogin(login);
  if(!user)return json(res,400,{error:'Неверный логин или пароль'});
  if(!verifyPwd(password,user.passwordHash))return json(res,400,{error:'Неверный логин или пароль'});
  if(user.twofaPassword || user.twofaWord){
    const faPass = String(b.twofaPassword||'');
    const faWord = String(b.twofaWord||'');
    if (!faPass && !faWord) return json(res, 200, { ok: false, need2fa: true });
    if (user.twofaPassword && faPass !== user.twofaPassword) return json(res, 400, { error: 'Неверный пароль 2FA' });
    if (user.twofaWord && faWord.toLowerCase().trim() !== (user.twofaWord||'').toLowerCase()) return json(res, 400, { error: 'Неверное кодовое слово' });
  }
  db.setOnline(user.id,true);
  const token=genToken();
  db.createSession(token,user.id);
  json(res,200,{ok:true,token,isNew:false,user:publicUser(user)});
}

async function apiMe(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  json(res,200,{...publicUser(u),online:u.online,lastSeen:u.lastSeen});
}

async function apiUpdateProfile(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req); const patch={};
  if('name' in b){const n=String(b.name||'').trim().slice(0,64); if(!n)return json(res,400,{error:'Пустое имя'}); patch.name=n;}
  if('username' in b){
    const un=String(b.username||'').trim().toLowerCase().slice(0,16);
    if(!/^[a-z0-9_]{5,16}$/.test(un))return json(res,400,{error:'Юзернейм: 5–16'});
    const t=db.findUserByUsername(un);
    if(t&&t.id!==u.id)return json(res,400,{error:'Занят'});
    patch.username=un;
  }
  if('bio' in b){
    let bio = String(b.bio||'').trim();
    if (bio.length > 100) bio = bio.slice(0, 100);
    patch.bio = bio;
  }
  if('birthday' in b)patch.birthday=String(b.birthday||'').trim().slice(0,40);
  db.updateUser(u.id,patch);
  json(res,200,{ok:true});
}

async function apiUpdateSettings(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req); const patch={};
  ['showLogin','showLastSeen','showBio','showBirthday'].forEach(k=>{
    if(k in b){const v=String(b[k]); if(['all','contacts','nobody'].includes(v))patch[k]=v;}
  });
  db.updateUser(u.id,patch);
  json(res,200,{ok:true});
}

async function apiSetup2fa(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const pass = String(b.password||'').trim();
  const word = String(b.word||'').trim();
  if (!pass && !word) {
    db.set2FA(u.id, null, null);
    return json(res,200,{ok:true, removed: true});
  }
  if (pass && pass.length < 4) return json(res,400,{error:'Пароль 2FA минимум 4 символа'});
  db.set2FA(u.id, pass || null, word || null);
  json(res,200,{ok:true});
}

// ===== UPLOADS =====
async function apiUploadAvatar(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  try{
    const buf=await readRaw(req,5*1024*1024);
    if(!buf.length)return json(res,400,{error:'Пустой файл'});
    const ext=detectExt(buf); if(!ext)return json(res,400,{error:'Только изображение'});
    const key='avatars/u'+u.id+'_'+Date.now()+ext;
    const mime=ext==='.jpg'?'image/jpeg':ext==='.png'?'image/png':'image/webp';
    await uploadToB2(buf,key,mime);
    db.updateUser(u.id,{avatar:'/uploads/'+key});
    json(res,200,{ok:true,avatar:'/uploads/'+key});
  }catch(e){console.error(e);json(res,400,{error:'Не удалось'})}
}

async function apiUploadChat(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  try{
    const buf=await readRaw(req,20*1024*1024);
    if(!buf.length)return json(res,400,{error:'Пустой файл'});
    const ext=detectExt(buf); if(!ext)return json(res,400,{error:'Только изображение'});
    const key='chat/'+Date.now()+'_'+Math.random().toString(36).slice(2,8)+ext;
    const mime=ext==='.jpg'?'image/jpeg':ext==='.png'?'image/png':ext==='.gif'?'image/gif':'image/webp';
    await uploadToB2(buf,key,mime);
    json(res,200,{ok:true,image:'/uploads/'+key});
  }catch(e){console.error(e);json(res,400,{error:'Не удалось'})}
}

async function apiUploadPost(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  try{
    const buf=await readRaw(req,20*1024*1024);
    if(!buf.length)return json(res,400,{error:'Пустой файл'});
    const ext=detectExt(buf); if(!ext)return json(res,400,{error:'Только изображение'});
    const key='posts/'+Date.now()+'_'+Math.random().toString(36).slice(2,8)+ext;
    const mime=ext==='.jpg'?'image/jpeg':ext==='.png'?'image/png':'image/webp';
    await uploadToB2(buf,key,mime);
    json(res,200,{ok:true,image:'/uploads/'+key});
  }catch(e){console.error(e);json(res,400,{error:'Не удалось'})}
}

async function apiUploadChannelAvatar(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  try{
    const buf=await readRaw(req,5*1024*1024);
    if(!buf.length)return json(res,400,{error:'Пустой файл'});
    const ext=detectExt(buf); if(!ext)return json(res,400,{error:'Только изображение'});
    const key='channels/'+Date.now()+'_'+Math.random().toString(36).slice(2,8)+ext;
    const mime=ext==='.jpg'?'image/jpeg':ext==='.png'?'image/png':'image/webp';
    await uploadToB2(buf,key,mime);
    json(res,200,{ok:true,image:'/uploads/'+key});
  }catch(e){console.error(e);json(res,400,{error:'Не удалось'})}
}

// ===== SEARCH =====
async function apiSearch(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const q=String(new URL(req.url,'http://x').searchParams.get('q')||'').trim().toLowerCase();
  if(!q)return json(res,200,{users:[],channels:[]});
  const r=db.findUserByUsername(q);
  const ch = db.findChannelByUsername(q);
  const users = (r && r.id !== u.id) ? [{
    id:r.id, name:r.name, username:r.username,
    avatar:r.avatar, isCreator:!!r.isCreator
  }] : [];
  const channels = ch ? [{
    id: ch.id, title: ch.title, username: ch.username,
    avatar: ch.avatar, subscribers: (ch.subscribers||[]).length
  }] : [];
  json(res,200,{users:users, channels:channels});
}

async function apiUserInfo(req,res){
  const me=getUser(req); if(!me)return json(res,401,{error:'Не авторизован'});
  const id=Number(new URL(req.url,'http://x').searchParams.get('id'));
  const u=db.findUserById(id); if(!u)return json(res,404,{error:'Не найден'});
  const isSelf=me.id===u.id;
  const out={
    id:u.id, name:u.name, username:u.username,
    extraUsernames:u.extraUsernames||[],
    avatar:u.avatar, online:!!u.online, lastSeen:u.lastSeen,
    oxy:u.oxy||0, gifts:u.gifts||[], nfts:u.nfts||[],
    profileNft:u.profileNft||null,
    isCreator:!!u.isCreator, isAdmin:!!u.isAdmin,
    isContact: db.isContact(me.id, u.id),
    posts: db.getPosts(u.id, 30)
  };
  if(isSelf){
    out.login=u.login; out.bio=u.bio||''; out.birthday=u.birthday||'';
    out.showLogin=u.showLogin; out.showBio=u.showBio;
    out.showBirthday=u.showBirthday; out.showLastSeen=u.showLastSeen;
  } else {
    out.login = u.showLogin === 'nobody' ? null : u.login;
    out.bio = u.showBio === 'nobody' ? '' : (u.bio || '');
    out.birthday = u.showBirthday === 'nobody' ? '' : (u.birthday || '');
    if(u.showLastSeen === 'nobody'){ out.online=false; out.lastSeen=null; }
  }
  json(res,200,out);
}
// ===== CHATS =====
async function apiChats(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  json(res,200,{chats:db.getUserChats(u.id)});
}
async function apiCreateChat(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const other=db.findUserById(Number(b.userId));
  if(!other)return json(res,400,{error:'Не найден'});
  if(other.id===u.id)return json(res,400,{error:'С собой нельзя'});
  const chat=db.createPrivateChat(u.id,other.id);
  json(res,200,{ok:true,chatId:chat.id});
}
async function apiMessages(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const chatId=Number(new URL(req.url,'http://x').searchParams.get('chatId'));
  const chat=db.getChatById(chatId);
  if(!chat)return json(res,404,{error:'Не найден'});
  if(chat.type === 'private' && !db.isChatMember(chatId,u.id))return json(res,403,{error:'Нет доступа'});
  const changed=db.markChatRead(chatId,u.id);
  if(changed){
    for(const m of chat.members) if(m!==u.id) sendToUser(m,{type:'read',chatId,by:u.id});
  }
  json(res,200,{messages:db.getChatMessages(chatId, u.id), chat: {
    id: chat.id, type: chat.type, title: chat.title || null,
    username: chat.username || null, avatar: chat.avatar || null,
    ownerId: chat.ownerId || null,
    subscribersCount: chat.subscribers ? chat.subscribers.length : 0,
    description: chat.description || null,
    isMember: chat.members ? chat.members.includes(u.id) : false
  }});
}

// ===== BLOCK / CLEAR =====
async function apiBlock(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const r = db.blockUser(u.id, Number(b.userId));
  if(r.error) return json(res,400,{error:r.error});
  json(res,200,{ok:true});
}
async function apiUnblock(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  db.unblockUser(u.id, Number(b.userId));
  json(res,200,{ok:true});
}
async function apiClearChat(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const chatId = Number(b.chatId);
  if(!db.isChatMember(chatId, u.id)) return json(res,403,{error:'Нет доступа'});
  if (b.all) {
    db.clearChatForAll(chatId);
  } else {
    db.clearChatForUser(chatId, u.id);
  }
  json(res,200,{ok:true});
}

// ===== OXY =====
async function apiOxyBalance(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  json(res,200,{balance:u.oxy||0,transactions:db.getTransactions(u.id,50)});
}
async function apiOxyTopup(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  if (!u.isAdmin) return json(res, 403, { error: 'Только для админа' });
  const b=await readBody(req);
  const amount=Math.max(1,Math.min(999999999,Number(b.amount)||0));
  const r=db.addOxy(u.id,amount,'Пополнение (админ)');
  json(res,200,{ok:true,balance:r.balance});
}

// ===== ORDINARY GIFTS =====
async function apiSendGift(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const toId=Number(b.toUserId);
  const giftId=String(b.giftId||'');
  const price=Number(b.price)||0;
  if(!toId||!giftId||!price)return json(res,400,{error:'Неверные данные'});
  const r=db.sendGift(u.id,toId,giftId,price);
  if(r.error)return json(res,400,{error:r.error});
  json(res,200,{ok:true});
}
async function apiSellGift(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const index = Number(b.index);
  if (isNaN(index) || index < 0) return json(res, 400, { error: 'Неверный индекс' });
  const r = db.sellGift(u.id, index);
  if (r.error) return json(res, 400, { error: r.error });
  json(res, 200, r);
}

// ===== NFT =====
async function apiNftPrices(req,res){
  json(res, 200, { prices: db.getNftPrices() });
}
async function apiNftBuy(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const type = String(b.type||'');
  const r = db.buyNft(u.id, type);
  if (r.error) return json(res, 400, { error: r.error });
  json(res, 200, r);
}
async function apiNftSell(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const nftId = String(b.nftId||'');
  const r = db.sellNft(u.id, nftId);
  if (r.error) return json(res, 400, { error: r.error });
  json(res, 200, r);
}
async function apiNftSetProfile(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const nftId = b.nftId === null ? null : String(b.nftId||'');
  const r = db.setProfileNft(u.id, nftId);
  if (r.error) return json(res, 400, { error: r.error });
  json(res, 200, r);
}
async function apiNftGive(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const toId = Number(b.toUserId);
  const nftId = String(b.nftId||'');
  if (!toId || !nftId) return json(res, 400, { error: 'Неверные данные' });
  const r = db.giveNft(u.id, toId, nftId);
  if (r.error) return json(res, 400, { error: r.error });
  json(res, 200, r);
}

// ===== USERNAMES =====
async function apiBuyUsername(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const username = String(b.username||'').trim().toLowerCase();
  const r = db.buyExtraUsername(u.id, username);
  if (r.error) return json(res, 400, { error: r.error });
  json(res, 200, r);
}
async function apiUsernamePrice(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const count = (u.extraUsernames||[]).length;
  json(res, 200, { price: db.getUsernamePrice(count+1), count, max: 5 });
}

// ===== CONTACTS =====
async function apiContacts(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  json(res,200,{contacts: db.getContacts(u.id)});
}
async function apiAddContact(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const r=db.addContact(u.id, Number(b.userId));
  if(r.error)return json(res,400,{error:r.error});
  json(res,200,{ok:true});
}

// ===== POSTS =====
async function apiUserPosts(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const id=Number(new URL(req.url,'http://x').searchParams.get('id'));
  json(res,200,{posts:db.getPosts(id,50)});
}
async function apiCreatePost(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const post = db.createPost(u.id, b.image||null, String(b.text||'').slice(0,1000));
  json(res,200,{ok:true,post:post});
}
async function apiDeletePost(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const r = db.deletePost(Number(b.postId), u.id);
  if(r.error)return json(res,400,{error:r.error});
  json(res,200,{ok:true});
}

// ===== CHANNELS =====
async function apiCreateChannel(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const title = String(b.title||'').trim();
  const username = b.username ? String(b.username).trim().toLowerCase() : null;
  const description = String(b.description||'').trim();
  const r = db.createChannel(u.id, title, username, description);
  if(r.error)return json(res,400,{error:r.error});
  json(res,200,r);
}
async function apiSubscribeChannel(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const r = db.subscribeToChannel(Number(b.chatId), u.id);
  if(r.error)return json(res,400,{error:r.error});
  json(res,200,r);
}
async function apiUnsubscribeChannel(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const b=await readBody(req);
  const r = db.unsubscribeFromChannel(Number(b.chatId), u.id);
  if(r.error)return json(res,400,{error:r.error});
  json(res,200,r);
}
async function apiChannelInfo(req,res){
  const u=getUser(req); if(!u)return json(res,401,{error:'Не авторизован'});
  const id=Number(new URL(req.url,'http://x').searchParams.get('id'));
  const chat=db.getChatById(id);
  if(!chat || chat.type !== 'channel')return json(res,404,{error:'Канал не найден'});
  json(res,200,{
    id: chat.id, title: chat.title, username: chat.username,
    description: chat.description || '', avatar: chat.avatar || null,
    ownerId: chat.ownerId,
    subscribersCount: (chat.subscribers||[]).length,
    isMember: (chat.members||[]).includes(u.id)
  });
}

// ===== HTTP =====
const server=http.createServer(async(req,res)=>{
  const url=req.url.split('?')[0];
  if(url.startsWith('/uploads/')){ return serveB2(req,res,decodeURIComponent(url.replace('/uploads/',''))); }
  try{
    if(url==='/api/register'     && req.method==='POST')return apiRegister(req,res);
    if(url==='/api/login'        && req.method==='POST')return apiLogin(req,res);
    if(url==='/api/me'           && req.method==='GET') return apiMe(req,res);
    if(url==='/api/profile'      && req.method==='POST')return apiUpdateProfile(req,res);
    if(url==='/api/settings'     && req.method==='POST')return apiUpdateSettings(req,res);
    if(url==='/api/2fa/setup'    && req.method==='POST')return apiSetup2fa(req,res);
    if(url==='/api/avatar'       && req.method==='POST')return apiUploadAvatar(req,res);
    if(url==='/api/upload-chat'  && req.method==='POST')return apiUploadChat(req,res);
    if(url==='/api/upload-post'  && req.method==='POST')return apiUploadPost(req,res);
    if(url==='/api/upload-channel-avatar' && req.method==='POST')return apiUploadChannelAvatar(req,res);
    if(url==='/api/search'       && req.method==='GET') return apiSearch(req,res);
    if(url==='/api/user'         && req.method==='GET') return apiUserInfo(req,res);
    if(url==='/api/chats'        && req.method==='GET') return apiChats(req,res);
    if(url==='/api/chats/create' && req.method==='POST')return apiCreateChat(req,res);
    if(url==='/api/messages'     && req.method==='GET') return apiMessages(req,res);
    if(url==='/api/block'        && req.method==='POST')return apiBlock(req,res);
    if(url==='/api/unblock'      && req.method==='POST')return apiUnblock(req,res);
    if(url==='/api/chat/clear'   && req.method==='POST')return apiClearChat(req,res);
    if(url==='/api/oxy'          && req.method==='GET') return apiOxyBalance(req,res);
    if(url==='/api/oxy/topup'    && req.method==='POST')return apiOxyTopup(req,res);
    if(url==='/api/gift'         && req.method==='POST')return apiSendGift(req,res);
    if(url==='/api/gift/sell'    && req.method==='POST')return apiSellGift(req,res);
    if(url==='/api/nft/prices'   && req.method==='GET') return apiNftPrices(req,res);
    if(url==='/api/nft/buy'      && req.method==='POST')return apiNftBuy(req,res);
    if(url==='/api/nft/sell'     && req.method==='POST')return apiNftSell(req,res);
    if(url==='/api/nft/profile'  && req.method==='POST')return apiNftSetProfile(req,res);
    if(url==='/api/nft/give'     && req.method==='POST')return apiNftGive(req,res);
    if(url==='/api/username/buy' && req.method==='POST')return apiBuyUsername(req,res);
    if(url==='/api/username/price'&&req.method==='GET') return apiUsernamePrice(req,res);
    if(url==='/api/contacts'     && req.method==='GET') return apiContacts(req,res);
    if(url==='/api/contacts/add' && req.method==='POST')return apiAddContact(req,res);
    if(url==='/api/posts'        && req.method==='GET') return apiUserPosts(req,res);
    if(url==='/api/posts/create' && req.method==='POST')return apiCreatePost(req,res);
    if(url==='/api/posts/delete' && req.method==='POST')return apiDeletePost(req,res);
    if(url==='/api/channel/create'  && req.method==='POST')return apiCreateChannel(req,res);
    if(url==='/api/channel/subscribe'&&req.method==='POST')return apiSubscribeChannel(req,res);
    if(url==='/api/channel/unsubscribe'&&req.method==='POST')return apiUnsubscribeChannel(req,res);
    if(url==='/api/channel'         && req.method==='GET') return apiChannelInfo(req,res);
  }catch(e){console.error('API ERROR:',e);return json(res,500,{error:'Ошибка'})}
  serveStatic(req,res);
});

// ===== WS =====
const wss=new WebSocketServer({server});
const clients=new Map();
function sendToUser(userId,obj){
  const msg=JSON.stringify(obj);
  for(const [ws,info] of clients){
    if(info.userId===userId&&ws.readyState===1)ws.send(msg);
  }
}
wss.on('connection',(ws,req)=>{
  const token=new URL(req.url,'http://x').searchParams.get('token');
  const s=db.getSession(token); if(!s){ws.close();return;}
  const u=db.findUserById(s.user_id); if(!u){ws.close();return;}
  clients.set(ws,{userId:u.id});
  db.setOnline(u.id,true);
  ws.on('message',(raw)=>{
    let d; try{d=JSON.parse(raw)}catch{return}
    if(d.type==='send'){
      const chatId=Number(d.chatId);
      const text=String(d.text||'').trim().slice(0,2000);
      const image=d.image?String(d.image).slice(0,500):null;
      const replyTo=d.replyTo?Number(d.replyTo):null;
      const nftData=d.nft||null;
      if(!text&&!image&&!nftData)return;
      if(!db.canWriteToChat(chatId,u.id))return;
      const chat=db.getChatById(chatId);
      if(chat.type === 'private'){
        for(const memberId of chat.members){
          if(memberId === u.id) continue;
          if(db.isBlocked(u.id, memberId)){
            ws.send(JSON.stringify({type:'blocked',chatId}));
            return;
          }
        }
      }
      const extra=nftData?{nft:nftData}:null;
      const msg=db.createMessage(chatId,u.id,text,image,replyTo,extra);
      const targets = chat.type === 'channel' ? (chat.subscribers||[]) : chat.members;
      for(const m of targets) sendToUser(m,{type:'message',chatId,message:msg});
    }
  });
  ws.on('close',()=>{ clients.delete(ws); db.setOnline(u.id,false); });
});

await loadData();
server.listen(PORT,()=>console.log('Сервер запущен: http://localhost:'+PORT));
