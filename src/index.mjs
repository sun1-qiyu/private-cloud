import webpush from 'web-push';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const META = '__private_cloud_meta_v1__';
const clean = (value, limit = 0) => { const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim(); return limit ? text.slice(0, limit) : text; };
const parse = (value, fallback = {}) => { try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'access-control-allow-origin':'*', 'access-control-allow-headers':'content-type', 'access-control-allow-methods':'GET, POST, OPTIONS' } });

async function hash(value) { const data = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value || ''))); return [...new Uint8Array(data)].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
function validDevice(input = {}) { const id = clean(input.id, 96), secret = clean(input.secret, 160); if (!id || !secret) throw new Error('设备凭据无效'); return { id, secret }; }
function validApi(raw = {}) { const api = { url:clean(raw.url,1200), key:clean(raw.key,4096), model:clean(raw.model,240), provider:clean(raw.provider,48), temp:Number(raw.temp) || .8 }; if (!/^https:\/\//i.test(api.url) || !api.key || !api.model) throw new Error('当前文字 API 配置不完整'); return api; }
async function readRow(db, id) { return db.prepare('SELECT * FROM private_cloud_state WHERE device_id=?').bind(id).first(); }
async function writeRow(db, id, secretHash, state) { await db.prepare('INSERT INTO private_cloud_state(device_id,secret_hash,state_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(device_id) DO UPDATE SET secret_hash=excluded.secret_hash,state_json=excluded.state_json,updated_at=excluded.updated_at').bind(id, secretHash, JSON.stringify(state), Date.now()).run(); }
async function meta(db) { const row = await readRow(db, META), state = parse(row?.state_json); if (state?.vapid?.publicKey && state?.vapid?.privateKey) return state; const keys = webpush.generateVAPIDKeys(); const next = { vapid:keys, lastRunAt:0 }; await writeRow(db, META, 'internal', next); return next; }
async function own(db, input) { const device = validDevice(input), row = await readRow(db, device.id); if (!row || row.device_id === META) throw new Error('设备尚未注册'); if (row.secret_hash !== await hash(device.secret)) throw new Error('设备凭据不匹配'); return { device, state:parse(row.state_json) }; }
function action(request) { const url = new URL(request.url); return clean(url.pathname.split('/').filter(Boolean).pop() || 'config', 32); }
async function body(request) { if (request.method === 'GET') return {}; const value = await request.json().catch(() => ({})); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求格式无效'); return value; }
function apiRoot(url) { return String(url).replace(/\/+$/, '').replace(/\/(v1\/chat\/completions|v4\/chat\/completions|api\/v3\/chat\/completions|chat\/completions|v1|v4|api\/v3)$/i, ''); }
async function complete(api, prompt) {
  const root = apiRoot(api.url), provider = api.provider === 'anthropic' || root.includes('anthropic.com') ? 'anthropic' : api.provider === 'gemini' || root.includes('generativelanguage.googleapis.com') ? 'gemini' : 'openai';
  let response;
  if (provider === 'anthropic') response = await fetch(`${root}/v1/messages`, { method:'POST', headers:{'x-api-key':api.key,'anthropic-version':'2023-06-01','content-type':'application/json'}, body:JSON.stringify({model:api.model,max_tokens:500,temperature:api.temp,messages:[{role:'user',content:prompt}]}) });
  else if (provider === 'gemini') response = await fetch(`${root.replace(/\/v1beta$/i,'')}/v1beta/models/${encodeURIComponent(api.model)}:generateContent?key=${encodeURIComponent(api.key)}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],generationConfig:{temperature:api.temp,maxOutputTokens:500}}) });
  else { const suffix = root.includes('open.bigmodel.cn') ? '/v4/chat/completions' : root.includes('volces.com') ? '/api/v3/chat/completions' : '/v1/chat/completions'; response = await fetch(`${root}${suffix}`, { method:'POST',headers:{authorization:`Bearer ${api.key}`,'content-type':'application/json'},body:JSON.stringify({model:api.model,temperature:api.temp,messages:[{role:'user',content:prompt}]}) }); }
  if (!response.ok) throw new Error(`文字 API HTTP ${response.status}`);
  const data = await response.json();
  return clean(provider === 'anthropic' ? (data.content || []).map(item => item?.text || '').join('') : provider === 'gemini' ? (data.candidates?.[0]?.content?.parts || []).map(item => item?.text || '').join('') : data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '', 1200);
}
function prompt(snapshot, hours) { const recent = Array.isArray(snapshot?.recentMessages) ? snapshot.recentMessages.slice(-8) : []; return `你是角色本人。根据人设、关系、日程与近期聊天，自然地给玩家发一条短消息；没有真实理由就只输出 [CANCEL]。不要提系统、通知、AI 或后台。\n\n角色：${clean(snapshot?.charName,80)}\n人设：${clean(snapshot?.personaSummary,4500)}\n关系：${clean(snapshot?.relationshipSummary,2400)}\n近期聊天：${recent.map(item => `${item.role === 'user' ? '玩家' : '角色'}：${clean(item.text,260)}`).join('\n')}\n角色日程：${clean(snapshot?.roleScheduleContext,1200)}\n玩家约 ${hours} 小时没有互动。`; }
async function sendPush(subscription, message, settings, vapid) { if (!subscription?.endpoint) return false; webpush.setVapidDetails('mailto:private-cloud@localhost', vapid.publicKey, vapid.privateKey); await webpush.sendNotification(subscription, JSON.stringify({version:1,type:'private-cloud-v1',messageId:message.id,title:message.title,body:settings?.notificationPreview === false ? '给你发来了一条消息' : message.text.slice(0,160),route:message.route,silent:false}), {TTL:86400,urgency:'normal'}); return true; }
async function processState(state, vapid, now) {
  if (!state.enabled || !state.apiProfile || !state.subscription) return state;
  const chars = state.characters && typeof state.characters === 'object' ? state.characters : {}, messages = Array.isArray(state.messages) ? state.messages : [];
  for (const [charId, entry] of Object.entries(chars)) {
    if (!entry?.enabled || Number(entry.nextCheckAt || 0) > now) continue;
    const snapshot = entry.snapshot || {}, settings = snapshot.settings || state.settings || {}, last = Number(snapshot.lastUserActivityAt || 0), absence = Math.max(2, Number(settings.absenceMinHours || 8)), interval = Math.max(1, Number(settings.minIntervalHours || 8));
    if (!last || now - last < absence * HOUR || now - Number(entry.lastSentAt || 0) < interval * HOUR) { chars[charId] = {...entry,nextCheckAt:now + 30 * MINUTE}; continue; }
    const text = await complete(state.apiProfile, prompt(snapshot, Math.floor((now - last) / HOUR))).catch(() => '');
    if (!text || /^\[?CANCEL\]?$/i.test(text)) { chars[charId] = {...entry,nextCheckAt:now + 6 * HOUR}; continue; }
    const message = {id:`pc_${crypto.randomUUID()}`,charId:String(charId),title:clean(snapshot.charName || '角色',80),text,route:`/?route=conversation&charId=${encodeURIComponent(String(charId))}`,createdAt:now,acknowledged:false};
    messages.unshift(message); await sendPush(state.subscription, message, settings, vapid).catch(() => false); chars[charId] = {...entry,nextCheckAt:now + interval * HOUR,lastSentAt:now};
  }
  return {...state,characters:chars,messages:messages.slice(0,80),updatedAt:now};
}
async function run(db) { const current = await meta(db), now = Date.now(); if (now - Number(current.lastRunAt || 0) < 45_000) return {ok:true,skipped:true}; await writeRow(db, META, 'internal', {...current,lastRunAt:now}); const {results} = await db.prepare('SELECT * FROM private_cloud_state WHERE device_id != ? LIMIT 100').bind(META).all(); for (const row of results || []) await writeRow(db, row.device_id, row.secret_hash, await processState(parse(row.state_json), current.vapid, now)); return {ok:true,processed:(results || []).length}; }

export default {
  async scheduled(_, env, ctx) { ctx.waitUntil(run(env.PRIVATE_CLOUD_DB)); },
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return json({ok:true});
    try {
      const currentAction = action(request), data = await body(request), db = env.PRIVATE_CLOUD_DB;
      if (!db) throw new Error('私有数据库尚未连接');
      if (currentAction === 'config') { const current = await meta(db); return json({ok:true,configured:true,privateCloudV1:true,vapidPublicKey:current.vapid.publicKey,version:1}); }
      if (currentAction === 'run') return json(await run(db));
      if (currentAction === 'enable') { const device = validDevice(data.device), existing = await readRow(db, device.id), secretHash = await hash(device.secret); if (existing?.secret_hash && existing.secret_hash !== secretHash) throw new Error('设备凭据不匹配'); const old = parse(existing?.state_json); await writeRow(db, device.id, secretHash, {...old,enabled:true,apiProfile:validApi(data.apiProfile),settings:data.settings || {},subscription:data.pushSubscription || null,characters:old.characters || {},messages:old.messages || []}); return json({ok:true,enabled:true}); }
      const current = await own(db, data.device);
      if (currentAction === 'settings') { await writeRow(db,current.device.id,await hash(current.device.secret),{...current.state,settings:data.settings || {},enabled:data.enabled === true,apiProfile:data.apiProfile ? validApi(data.apiProfile) : current.state.apiProfile}); return json({ok:true}); }
      if (currentAction === 'snapshot') { const id = clean(data.charId,120); if (!id) throw new Error('角色无效'); const chars = {...(current.state.characters || {})}; chars[id] = {enabled:data.enabled !== false,snapshot:data.snapshot || {},nextCheckAt:Number(data.nextCheckAt) || Date.now() + MINUTE,lastSentAt:Number(chars[id]?.lastSentAt || 0)}; await writeRow(db,current.device.id,await hash(current.device.secret),{...current.state,characters:chars}); return json({ok:true}); }
      if (currentAction === 'reconcile') return json({ok:true,messages:(current.state.messages || []).filter(item => !item.acknowledged).map(item => ({message_id:item.id,char_id:item.charId,text:item.text,created_at:item.createdAt,intent_type:'absence_checkin'})),jobReceipts:[]});
      if (currentAction === 'ack') { const ids = new Set(Array.isArray(data.messageIds) ? data.messageIds.map(String) : []); await writeRow(db,current.device.id,await hash(current.device.secret),{...current.state,messages:(current.state.messages || []).map(item => ids.has(String(item.id)) ? {...item,acknowledged:true} : item)}); return json({ok:true,count:ids.size}); }
      if (currentAction === 'disable') { if (data.purge === true) await db.prepare('DELETE FROM private_cloud_state WHERE device_id=?').bind(current.device.id).run(); else await writeRow(db,current.device.id,await hash(current.device.secret),{...current.state,enabled:false,subscription:null,apiProfile:null}); return json({ok:true}); }
      return json({ok:false,error:'未知操作'},404);
    } catch (error) { return json({ok:false,error:clean(error?.message || error,180) || '私有云端暂时不可用'},400); }
  }
};
