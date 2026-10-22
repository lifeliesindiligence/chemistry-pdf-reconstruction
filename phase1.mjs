// First-stage SIWC feasibility probe. No credentials or scanned files enter source control.
// Run only after this app is genuinely released as open source or separately approved.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const CALLBACK = '/auth/callback';
const APP_NAME = 'Chemistry PDF Reconstruction';
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const b64 = b => Buffer.from(b).toString('base64url');
const random = () => b64(crypto.randomBytes(32));
const safeEq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const h = text => String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function verifyIdToken(token, jwks, clientId, nonce, now = Date.now()) {
  const parts = token.split('.');
  if (parts.length !== 3) throw Error('id_token malformed');
  const head = JSON.parse(Buffer.from(parts[0], 'base64url'));
  if (head.alg !== 'RS256' || head.typ && head.typ !== 'JWT' || !head.kid) throw Error('id_token algorithm or key invalid');
  const key = jwks.keys?.find(x => x.kid === head.kid && x.kty === 'RSA' && x.use === 'sig');
  if (!key) throw Error('id_token signing key unavailable');
  const publicKey = crypto.createPublicKey({key, format:'jwk'});
  const ok = crypto.verify('RSA-SHA256', Buffer.from(parts[0]+'.'+parts[1]), publicKey, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw Error('id_token signature invalid');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  if (claims.iss !== ISSUER || !(claims.aud === clientId || Array.isArray(claims.aud) && claims.aud.includes(clientId)) || !claims.sub || !safeEq(claims.nonce, nonce)) throw Error('id_token claims invalid');
  if (!Number.isSafeInteger(claims.exp) || claims.exp * 1000 <= now || !Number.isSafeInteger(claims.iat) || claims.iat * 1000 > now + 60000) throw Error('id_token time invalid');
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId) throw Error('id_token authorized party invalid');
  return {sub: claims.sub, email: claims.email ?? null};
}

export function parseSseEvent(raw) {
  const data = raw.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
  if (!data || data === '[DONE]') return null;
  return JSON.parse(data);
}

export async function readResponseStream(body) {
  let pending = ''; let complete = false; let text = '';
  const decoder = new TextDecoder('utf-8', {fatal:true});
  for await (const chunk of body) {
    pending += decoder.decode(chunk, {stream:true});
    if (pending.length > 8_000_000) throw Error('stream too large');
    let p;
    while ((p = pending.indexOf('\n\n')) >= 0 || (p = pending.indexOf('\r\n\r\n')) >= 0) {
      const len = pending.slice(p, p+4) === '\r\n\r\n' ? 4 : 2;
      const event = parseSseEvent(pending.slice(0,p)); pending = pending.slice(p+len);
      if (!event) continue;
      if (event.type === 'response.output_text.delta') text += event.delta || '';
      if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') throw Error('inference '+event.type+': '+(event.response?.error?.code || event.error?.code || 'unknown'));
      if (event.type === 'response.completed') complete = true;
    }
  }
  pending += decoder.decode();
  if (!complete || !text.trim()) throw Error('no completed text response');
  return text;
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {signal: AbortSignal.timeout(90000), ...options});
  if (!response.ok) {
    const payload = await response.json().catch(()=>({}));
    throw Error('HTTP '+response.status+' '+url.split('?')[0]+' code='+(payload.error?.code||'unknown')+' request_id='+(response.headers.get('x-request-id')||'unknown'));
  }
  return response.json();
}

function send(res, status, html) {
  res.writeHead(status, {'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'"});
  res.end('<!doctype html><html lang="zh"><meta charset="utf-8"><title>扫描识别授权验证</title><body style="font:16px system-ui;max-width:750px;margin:3rem auto;line-height:1.7"><h1>扫描试卷 · 第一阶段</h1>'+html+'</body></html>');
}

export function makeAuthUrl({clientId='dynamic_agent_client', hostId, redirectUri, state, nonce, verifier}) {
  const u = new URL(ISSUER+'/api/accounts/authorize');
  const q = {client_id:clientId,ext_agent_host_id:hostId,response_type:'code',redirect_uri:redirectUri,scope:SCOPE,resource:RESOURCE,state,nonce,code_challenge_method:'S256',code_challenge:b64(crypto.createHash('sha256').update(verifier).digest())};
  if (clientId === 'dynamic_agent_client') q.agent_name_hint = APP_NAME;
  for (const [k,v] of Object.entries(q)) u.searchParams.set(k,v);
  return u.toString();
}

export async function runProbe({image, privateDir, hostFile, publicReleaseConfirmed}) {
  if (!publicReleaseConfirmed) throw Error('Open-source release not confirmed; OAuth disabled.');
  const src = path.resolve(image);
  if (!fs.statSync(src).isFile() || !src.toLowerCase().endsWith('.png')) throw Error('Private scanned PNG required');
  if (src.startsWith(here + path.sep)) throw Error('Scan image must stay outside public source folder');
  if (path.resolve(privateDir).startsWith(here + path.sep)) throw Error('Private status directory must stay outside public source folder');
  fs.mkdirSync(privateDir, {recursive:true});
  const hostPath = path.join(privateDir, 'host-id.txt');
  let hostId;
  if (fs.existsSync(hostPath)) hostId = fs.readFileSync(hostPath,'utf8').trim();
  else {hostId='urn:uuid:'+crypto.randomUUID(); fs.writeFileSync(hostPath,hostId,{flag:'wx',mode:0o600});}
  if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(hostId)) throw Error('Host identifier invalid');
  let phase = 'ready'; let status = {stage:'ready', succeeded:false};
  let pending = null; let token = null; let issuedClientId = null;
  const save = () => { const tmp=path.join(privateDir,'phase1-status.tmp');fs.writeFileSync(tmp,JSON.stringify(status,null,2),{mode:0o600});fs.renameSync(tmp,path.join(privateDir,'phase1-status.json')); };
  const server = http.createServer(async (req,res) => {
    const u = new URL(req.url,'http://127.0.0.1');
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) return send(res,400,'仅允许本机 127.0.0.1 访问。');
    if (req.method !== 'GET') return send(res,405,'仅允许读取。');
    if (u.pathname === '/') return send(res,200,phase==='ready' ? '<p>只做一次授权与扫描图像识别。试卷图像仅发送至 OpenAI 官方服务，不会进入公开源码。</p><a href="/begin">Continue with ChatGPT</a>' : '<p>状态：'+h(phase)+'</p><p>识别是否成功：'+(status.succeeded?'是':'否')+'</p>'+(status.text?'<pre>'+h(status.text)+'</pre>':''));
    if (u.pathname === '/begin' && phase === 'ready') {
      const state=random(),nonce=random(),verifier=random();
      const redirectUri=`http://127.0.0.1:${server.address().port}${CALLBACK}`;
      pending={state,nonce,verifier,redirectUri,created:Date.now()}; phase='waiting_for_user';
      const url=makeAuthUrl({hostId,redirectUri,state,nonce,verifier});
      res.writeHead(302,{'location':url,'cache-control':'no-store','referrer-policy':'no-referrer'});return res.end();
    }
    if (u.pathname === CALLBACK) {
      const tx=pending; pending=null;
      if (!tx || Date.now()-tx.created>600000 || !safeEq(u.searchParams.get('state'),tx.state)) {phase='failed';status={stage:'invalid_oauth_state',succeeded:false};save();return send(res,400,'授权状态无效或过期。请停止本次尝试。');}
      if (u.searchParams.has('error')) {phase='failed';status={stage:'authorization_declined',succeeded:false};save();return send(res,400,'授权未获批准，不会发送图像。');}
      const code=u.searchParams.get('code'), clientId=u.searchParams.get('client_id');
      if (!code || !clientId || !/^oaiapp_[\w-]+$/.test(clientId)) {phase='failed';status={stage:'registration_incomplete',succeeded:false};save();return send(res,400,'未收到有效的正式客户端 ID。');}
      phase='validating'; send(res,200,'已收到授权回调，正在校验身份与权限并进行一次扫描图像识别。请稍后刷新首页查看状态。');
      try {
        const tokens=await jsonRequest(ISSUER+'/api/accounts/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code,code_verifier:tx.verifier,redirect_uri:tx.redirectUri,resource:RESOURCE})});
        if (!tokens.id_token) throw Error('id_token missing');
        const jwks=await jsonRequest(ISSUER+'/.well-known/jwks.json');
        const identity=verifyIdToken(tokens.id_token,jwks,clientId,tx.nonce);
        const granted=new Set(String(tokens.scope||'').split(/\s+/));
        if (!granted.has('chatgpt.tokens.use.direct') || !granted.has('resource.invoke') || !tokens.access_token) throw Error('ChatGPT plan usage scope not granted');
        issuedClientId=clientId;token=tokens.access_token;
        status={stage:'authorized',succeeded:false,accountVerified:!!identity.sub,planScopeGranted:true};save();phase='model_lookup';
        const catalog=await jsonRequest(RESOURCE+'/models',{headers:{authorization:'Bearer '+token}});
        const slugs=(catalog.models||[]).filter(m=>m.visibility==='list').map(m=>m.slug);
        const model=['gpt-6.1-sol','gpt-6-sol','gpt-5.4'].find(x=>slugs.includes(x));
        if (!model) throw Error('No documented candidate image model in account catalog');
        const bytes=fs.readFileSync(src);
        if (bytes.length>8_000_000 || !bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) throw Error('Private scan is not a valid small PNG');
        const payload={model,input:[{role:'user',content:[{type:'input_text',text:'请忠实抄录图片中能清楚辨认的化学试卷标题与第一道题，不要补造模糊内容。'},{type:'input_image',image_url:'data:image/png;base64,'+bytes.toString('base64')}]}],store:false,stream:true};
        phase='inference';status={stage:'inference',succeeded:false,model,accountVerified:true,planScopeGranted:true};save();
        const response=await fetch(RESOURCE+'/responses',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(120000)});
        if (!response.ok) {
          const payload=await response.json().catch(()=>({}));
          throw Error('inference HTTP '+response.status+' code='+(payload.error?.code||'unknown')+' request_id='+(response.headers.get('x-request-id')||'unknown'));
        }
        const text=await readResponseStream(response.body);
        status={stage:'response_completed',succeeded:true,model,accountVerified:true,planScopeGranted:true,text};save();phase='completed';
      } catch(e) {status={...status,stage:'failed',succeeded:false,error:String(e.message).replace(/(Bearer\s+)[^\s]+/ig,'$1[REDACTED]').slice(0,600)};save();phase='failed';}
      finally {token=null;issuedClientId=null;}
      return;
    }
    return send(res,404,'未找到页面。');
  });
  server.listen(0,'127.0.0.1',()=>{save();console.log('PHASE1_URL=http://127.0.0.1:'+server.address().port+'/');console.log('STATUS_FILE='+path.join(privateDir,'phase1-status.json'));});
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const image=arg('--image'), privateDir=arg('--private-dir');
  if (!image || !privateDir) {console.error('Usage: node phase1.mjs --image PRIVATE_SCAN.png --private-dir PRIVATE_DIR --open-source-release-confirmed');process.exitCode=2;}
  else runProbe({image,privateDir,publicReleaseConfirmed:args.includes('--open-source-release-confirmed')}).catch(e=>{console.error('STOP: '+e.message);process.exitCode=1;});
}
