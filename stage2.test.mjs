import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createApp, validatePdf, transcriptionPrompt, classifyPageText, runDocumentHelper} from './stage2.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
test('rejects source tree, traversal, non-PDF and oversized input', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'stage2-safe-'));
  try {
    const pdf=path.join(root,'scan.pdf'); fs.writeFileSync(pdf,Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(128)]));
    const output=fs.mkdtempSync(path.join(os.tmpdir(),'stage2-out-'));
    try {
      assert.equal(validatePdf(pdf,output).path,fs.realpathSync(pdf));
      assert.throws(()=>validatePdf(path.join(source,'README.md'),output));
      assert.throws(()=>validatePdf(path.join(root,'..','untrusted.pdf'),output));
      assert.throws(()=>validatePdf(root+path.sep+'..'+path.sep+path.basename(root)+path.sep+'scan.pdf',output));
      assert.throws(()=>validatePdf(pdf,output,100));
    } finally {fs.rmSync(output,{recursive:true,force:true});}
    assert.throws(()=>validatePdf(path.join(root,'missing.pdf'),root));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('source directory cannot be used as private output',async()=>{
  await assert.rejects(createApp({privateDir:source}),/outside source/);
});
test('prompt requires complete selected page and explicit partial declaration',()=>{
  const prompt=transcriptionPrompt(3);
  assert.match(prompt,/完整|全部/);
  assert.match(prompt,/部分|不完整/);
  assert.match(prompt,/3/);
});
test('unmarked transcription is partial and empty response fails',()=>{
  assert.equal(classifyPageText('只抄录首题').complete,false);
  assert.equal(classifyPageText('[[PAGE_PARTIAL]]\n只抄录首题').complete,false);
  assert.equal(classifyPageText('[[PAGE_COMPLETE]]\n标题\n末题').complete,true);
  assert.throws(()=>classifyPageText('[[PAGE_COMPLETE]]\n'));
});
test('document helper rejects missing executable or failed exit without fake success',async()=>{
  await assert.rejects(runDocumentHelper('no-such-helper-executable-987', ['--render','x']),/helper|spawn/i);
});
test('local app does not call network before Continue and rejects forged host and POST origin',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'stage2-app-'));
  let called=0;
  const app=await createApp({privateDir:root, fetchImpl:async()=>{called++;throw Error('unexpected');}});
  try {
    const base=`http://127.0.0.1:${app.address().port}`;
    const home=await fetch(base+'/');assert.equal(home.status,200);assert.match(await home.text(),/Continue with ChatGPT/);
    const forged=await new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port:app.address().port,path:'/',headers:{host:'evil.test'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(forged,400);
    const csrf=await fetch(base+'/begin',{method:'POST'});assert.equal(csrf.status,403);
    const status=JSON.parse(fs.readFileSync(path.join(root,'phase2-status.json')));
    assert.equal(status.succeeded,false); assert.equal(called,0);
  } finally {await new Promise(resolve=>app.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
test('OAuth state mismatch and denied consent never exchange a code',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'stage2-oauth-'));
  let calls=0;
  const app=await createApp({privateDir:root,fetchImpl:async()=>{calls++;throw Error('network forbidden');}});
  try {
    const base=`http://127.0.0.1:${app.address().port}`;
    assert.equal((await fetch(base+'/run',{method:'POST',headers:{origin:base}})).status,403);
    const begin=await fetch(base+'/begin',{method:'POST',headers:{origin:base},redirect:'manual'});
    assert.equal(begin.status,303);
    const authorize=new URL(begin.headers.get('location'));
    assert.equal(authorize.hostname,'auth.openai.com');
    assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
    const state=authorize.searchParams.get('state');
    assert.equal((await fetch(base+'/auth/callback?state=wrong&code=sample&client_id=oaiapp_test')).status,400);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'phase2-status.json'))).succeeded,false);
    assert.equal(calls,0);
    const again=await fetch(base+'/begin',{method:'POST',headers:{origin:base},redirect:'manual'});
    const state2=new URL(again.headers.get('location')).searchParams.get('state');
    assert.notEqual(state2,state);
    assert.equal((await fetch(base+'/auth/callback?state='+encodeURIComponent(state2)+'&error=access_denied')).status,400);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'phase2-status.json'))).stage,'authorization_declined');
    assert.equal(calls,0);
  } finally {await new Promise(resolve=>app.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
