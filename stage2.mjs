// Local stage 2. Private scans/results never belong in this public source tree.
// Helper contract: stage2_document.py render --pdf PDF --pages N --output-dir DIR;
// stage2_document.py build --input JSON --output DOCX. JSON: [{page,content}].
// Launch: node stage2.mjs --private-dir OUTSIDE_SOURCE [--python PYTHON_EXE]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {verifyIdToken,makeAuthUrl,readResponseStream} from './phase1.mjs';

const SOURCE=path.dirname(fileURLToPath(import.meta.url));
const RESOURCE='https://api.openai.com/v1';
const ISSUER='https://auth.openai.com';
const CALLBACK='/auth/callback';
const MAX_PDF=60_000_000;
const execFileAsync=promisify(execFile);
const inside=(p,root)=>p===root || p.startsWith(root+path.sep);
const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const random=()=>crypto.randomBytes(32).toString('base64url');
const same=(a,b)=>typeof a==='string' && typeof b==='string' && a.length===b.length && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const safeError=e=>{const s=String(e?.message||'unknown'); return /timeout|timed out|abort/i.test(s)?'timeout':/incomplete|no completed/i.test(s)?'inference_incomplete':/helper|spawn|ENOENT|exited|Command failed/i.test(s)?'document_helper_failed':/HTTP \d{3}/.test(s)?s.match(/HTTP \d{3}/)[0]:'operation_failed';};

export function validatePdf(input,privateDir,maxBytes=MAX_PDF) {
  if(typeof input!=='string'||!input.trim()||input.includes('\0')||!path.isAbsolute(input.trim())||input.replaceAll('\\','/').split('/').includes('..')) throw Error('PDF path invalid');
  const resolved=path.resolve(input.trim());
  const real=fs.realpathSync(resolved);
  const source=fs.realpathSync(SOURCE);
  if(inside(real,source)||inside(resolved,source)||inside(real,fs.realpathSync(privateDir))) throw Error('PDF must be outside source and output directory');
  const info=fs.statSync(real);
  if(!info.isFile()||!real.toLowerCase().endsWith('.pdf')||info.size>maxBytes||info.size<8) throw Error('PDF type or size invalid');
  const fd=fs.openSync(real,'r');
  try {const head=Buffer.alloc(5);fs.readSync(fd,head,0,5,0);if(head.toString()!=='%PDF-') throw Error('PDF signature invalid');}finally{fs.closeSync(fd);}
  return {path:real,size:info.size};
}
export function transcriptionPrompt(page) {
  return `请只识别这张化学试卷第 ${page} 页图片，按阅读顺序完整抄录本页全部可辨文字（含标题、题号、选项、表格、页脚）。不要凭空补字；模糊处写[无法辨认]。第一行必须为 [[PAGE_COMPLETE]]（确认整页都已抄录）或 [[PAGE_PARTIAL]]（只识别到部分、不确定是否完整）；如有裁切、图示无法表述或遗漏，必须标记部分/不完整。第一行后只输出识别正文，不输出解释。`;
}
export async function runDocumentHelper(python,args,{timeout=45000}={}) {
  try {await execFileAsync(python,[path.join(SOURCE,'stage2_document.py'),...args],{timeout,maxBuffer:32768,windowsHide:true});}
  catch(e) {throw Error(e?.killed?'helper timeout':'document helper failed');}
}
export function classifyPageText(text){
  const match=text.match(/^\s*\[\[PAGE_(COMPLETE|PARTIAL)\]\]\s*\r?\n/i);
  const clean=match?text.slice(match[0].length).trim():text.trim();
  if(!clean) throw Error('no completed text response');
  return {text:clean,complete:match?.[1].toUpperCase()==='COMPLETE'};
}
function jsonWrite(file,value){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);}
async function requestJson(fetchImpl,url,options={}) {
  const res=await fetchImpl(url,{...options,signal:AbortSignal.timeout(30000)});
  if(!res.ok) throw Error(`HTTP ${res.status}`);
  return res.json();
}
async function form(req){
  let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)throw Error('form too large');}
  return new URLSearchParams(body);
}
function html(res,status,body){res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>逐页试卷识别</title><body style="font:16px system-ui;max-width:800px;margin:3rem auto;line-height:1.6"><h1>逐页试卷识别</h1>${body}</body></html>`);}
export async function createApp({privateDir,python='D:/AI/PaddleOCR/venv/Scripts/python.exe',fetchImpl=fetch}={}){
  if(!privateDir)throw Error('--private-dir required');
  const output=path.resolve(privateDir);
  const source=fs.realpathSync(SOURCE);
  // Refuse the source tree and any output path resolving through a symlink into it.
  if(inside(output,source))throw Error('private output must be outside source');
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  const privateReal=fs.realpathSync(output);
  if(inside(privateReal,source))throw Error('private output must be outside source');
  const hostPath=path.join(privateReal,'phase2-host-id.txt');
  let hostId;
  try {hostId=fs.readFileSync(hostPath,'utf8').trim();}catch(e){if(e.code!=='ENOENT')throw e;hostId='urn:uuid:'+crypto.randomUUID();try{fs.writeFileSync(hostPath,hostId,{flag:'wx',mode:0o600});}catch(err){if(err.code!=='EEXIST')throw err;hostId=fs.readFileSync(hostPath,'utf8').trim();}}
  if(!/^urn:uuid:[0-9a-f-]{36}$/i.test(hostId))throw Error('host identifier invalid');
  let status={stage:'ready',succeeded:false};
  const save=()=>jsonWrite(path.join(privateReal,'phase2-status.json'),status);
  save();
  let pending=null,token=null,selected=null,busy=false,finishedDoc=null;
  const server=http.createServer(async(req,res)=>{
    const port=server.address()?.port;
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==`127.0.0.1:${port}`)return html(res,400,'Local host only.');
    const base=`http://127.0.0.1:${port}`;
    let url;try{url=new URL(req.url,base);}catch{return html(res,400,'Invalid URL');}
    if(url.origin!==base)return html(res,400,'Invalid URL');
    if(req.method==='POST' && req.headers.origin!==base)return html(res,403,'Origin rejected.');
    try {
      if(req.method==='GET'&&url.pathname==='/')return html(res,200,`<p>仅在你点击 Continue with ChatGPT 后跳转 OpenAI 官方授权；选择的页图才会发送到 OpenAI。</p><p>状态：${escapeHtml(status.stage)}；完整识别：${status.succeeded?'模型标记完整（未经人工核对）':'未完成'}</p>${status.error?`<p>错误：${escapeHtml(status.error)}</p>`:''}<form method="post" action="/begin"><button>Continue with ChatGPT</button></form><form method="post" action="/run"><label>本地 PDF 绝对路径 <input name="pdf" size="75" required></label><label>页码 <input type="number" name="page" min="1" value="1" required></label><button>识别选中页并生成 DOCX</button></form>${finishedDoc?'<p><a href="/result.docx">下载可编辑 DOCX</a></p>':''}<p>请在授权后选择本地 PDF；文件和结果不能位于源码目录。</p>`);
      if(req.method==='POST'&&url.pathname==='/begin'){
        if(busy||pending)return html(res,409,'Authorization already pending.');
        token=null;finishedDoc=null;
        const state=random(),nonce=random(),verifier=random(),redirectUri=base+CALLBACK;
        pending={state,nonce,verifier,redirectUri,created:Date.now()};
        status={stage:'waiting_for_user',succeeded:false};save();
        res.writeHead(303,{'location':makeAuthUrl({hostId,redirectUri,state,nonce,verifier}),'cache-control':'no-store','referrer-policy':'no-referrer'});return res.end();
      }
      if(req.method==='GET'&&url.pathname===CALLBACK){
        const tx=pending;pending=null;
        if(!tx||Date.now()-tx.created>600000||!same(url.searchParams.get('state'),tx.state)){status={stage:'invalid_oauth_state',succeeded:false};save();return html(res,400,'OAuth state invalid or expired.');}
        if(url.searchParams.has('error')){status={stage:'authorization_declined',succeeded:false};save();return html(res,400,'Authorization declined.');}
        const code=url.searchParams.get('code'),clientId=url.searchParams.get('client_id');
        if(!code||!/^oaiapp_[\w-]+$/.test(clientId||'')){status={stage:'registration_incomplete',succeeded:false};save();return html(res,400,'Client registration incomplete.');}
        busy=true;status={stage:'validating_identity',succeeded:false};save();html(res,200,'正在校验官方授权，请刷新首页查看状态。');
        try {
          const tokens=await requestJson(fetchImpl,ISSUER+'/api/accounts/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code,code_verifier:tx.verifier,redirect_uri:tx.redirectUri,resource:RESOURCE})});
          if(!tokens.id_token)throw Error('id_token missing');
          const jwks=await requestJson(fetchImpl,ISSUER+'/.well-known/jwks.json');
          verifyIdToken(tokens.id_token,jwks,clientId,tx.nonce);
          const scopes=new Set(String(tokens.scope||'').split(/\s+/));
          if(!scopes.has('chatgpt.tokens.use.direct')||!scopes.has('resource.invoke')||!tokens.access_token)throw Error('plan permission denied');
          token=tokens.access_token;status={stage:'authorized',succeeded:false,planScopeGranted:true};save();
        }catch(e){token=null;status={stage:'authorization_failed',succeeded:false,error:safeError(e)};save();}finally{busy=false;}
        return;
      }
      if(req.method==='POST'&&url.pathname==='/run'){
        if(!token)return html(res,403,'Authorize ChatGPT plan use first.');
        if(busy)return html(res,409,'Job already running.');
        const fields=await form(req);const page=Number(fields.get('page'));
        if(!Number.isSafeInteger(page)||page<1||page>1000)return html(res,400,'Invalid page number.');
        let pdf;try{pdf=validatePdf(fields.get('pdf'),privateReal);}catch{return html(res,400,'Invalid PDF path or size.');}
        selected={pdf:pdf.path,page};busy=true;finishedDoc=null;
        const id=crypto.randomUUID(),dir=path.join(privateReal,'jobs',id);
        fs.mkdirSync(dir,{recursive:true,mode:0o700});
        status={stage:'rendering',succeeded:false,page};save();html(res,200,'任务已开始。请刷新首页查看状态。');
        void (async()=>{
          try {
            const image=path.join(dir,`page-${String(page).padStart(4,'0')}.png`);
            await runDocumentHelper(python,['render','--pdf',selected.pdf,'--pages',String(page),'--output-dir',dir]);
            const png=fs.readFileSync(image);
            if(png.length>8_000_000||png.length<8||!png.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw Error('rendered PNG invalid');
            status={stage:'model_lookup',succeeded:false,page};save();
            const catalog=await requestJson(fetchImpl,RESOURCE+'/models',{headers:{authorization:'Bearer '+token}});
            const slugs=(catalog.models||[]).filter(m=>m.visibility==='list').map(m=>m.slug);
            const model=['gpt-6.1-sol','gpt-6-sol','gpt-5.4'].find(x=>slugs.includes(x));
            if(!model)throw Error('image model unavailable');
            status={stage:'inference',succeeded:false,page,model};save();
            const payload={model,input:[{role:'user',content:[{type:'input_text',text:transcriptionPrompt(page)},{type:'input_image',image_url:'data:image/png;base64,'+png.toString('base64')}]}],store:false,stream:true};
            const response=await fetchImpl(RESOURCE+'/responses',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(120000)});
            if(!response.ok)throw Error(`HTTP ${response.status}`);
            const result=classifyPageText(await readResponseStream(response.body));
            const json=path.join(dir,'result.json'),doc=path.join(dir,'result.docx');
            jsonWrite(json,{page,text:result.text,complete:result.complete,model,source:'model_transcription_unverified'});
            const buildInput=path.join(dir,'build-input.json');
            jsonWrite(buildInput,[{page,content:result.complete?result.text:'[部分识别／未经人工核对]\n'+result.text}]);
            status={stage:'building_docx',succeeded:false,page,model};save();
            await runDocumentHelper(python,['build','--input',buildInput,'--output',doc]);
            if(!fs.statSync(doc).isFile()||fs.statSync(doc).size<100)throw Error('DOCX missing');
            finishedDoc=doc;
            status={stage:result.complete?'model_reported_complete':'partial_page',succeeded:result.complete,page,model,docx:doc,verification:'not_human_verified'};save();
          }catch(e){finishedDoc=null;status={stage:'failed',succeeded:false,page,error:safeError(e)};save();}
          finally{busy=false;selected=null;}
        })();return;
      }
      if(req.method==='GET'&&url.pathname==='/result.docx'){
        if(!finishedDoc||!fs.existsSync(finishedDoc))return html(res,404,'No document available.');
        res.writeHead(200,{'content-type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','content-disposition':'attachment; filename="page.docx"','cache-control':'no-store','x-content-type-options':'nosniff'});
        return fs.createReadStream(finishedDoc).pipe(res);
      }
      return html(res,404,'Not found.');
    }catch(e){status={stage:'failed',succeeded:false,error:safeError(e)};save();if(!res.headersSent)html(res,400,'Request failed.');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
  createApp({privateDir:arg('--private-dir'),python:arg('--python')||undefined}).then(server=>console.log(`STAGE2_URL=http://127.0.0.1:${server.address().port}/`)).catch(e=>{console.error('STOP: '+safeError(e));process.exitCode=1;});
}
