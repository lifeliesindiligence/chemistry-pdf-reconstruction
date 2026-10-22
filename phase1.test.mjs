import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {makeAuthUrl, verifyIdToken, readResponseStream, runProbe} from './phase1.mjs';

const enc = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function signedToken(claims) {
  const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  const header=enc({alg:'RS256',kid:'local-test',typ:'JWT'}), payload=enc(claims);
  const sig=crypto.sign('RSA-SHA256',Buffer.from(header+'.'+payload),privateKey).toString('base64url');
  const jwk=publicKey.export({format:'jwk'});return {jwt:header+'.'+payload+'.'+sig,jwks:{keys:[{...jwk,kid:'local-test',use:'sig'}]}};
}
test('OAuth dynamic registration parameters and PKCE',()=>{
  const u=new URL(makeAuthUrl({hostId:'urn:uuid:550e8400-e29b-41d4-a716-446655440000',redirectUri:'http://127.0.0.1:52525/auth/callback',state:'s',nonce:'n',verifier:'v'}));
  assert.equal(u.hostname,'auth.openai.com');assert.equal(u.searchParams.get('client_id'),'dynamic_agent_client');
  assert.equal(u.searchParams.get('scope'),'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
  assert.equal(u.searchParams.get('resource'),'https://api.openai.com/v1');
  assert.equal(u.searchParams.get('redirect_uri'),'http://127.0.0.1:52525/auth/callback');
  assert.equal(u.searchParams.get('code_challenge'),crypto.createHash('sha256').update('v').digest('base64url'));
  assert.ok(u.searchParams.get('agent_name_hint'));
});
test('JWT signature, audience, issuer, nonce and expiry are verified',()=>{
  const claims={iss:'https://auth.openai.com',aud:'oaiapp_test',nonce:'n',sub:'test-sub',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300};
  const {jwt,jwks}=signedToken(claims);
  assert.equal(verifyIdToken(jwt,jwks,'oaiapp_test','n').sub,'test-sub');
  assert.throws(()=>verifyIdToken(jwt,jwks,'oaiapp_other','n'),/claims/);
  assert.throws(()=>verifyIdToken(jwt,jwks,'oaiapp_test','wrong'),/claims/);
  assert.throws(()=>verifyIdToken(jwt.slice(0,-3)+'BAD',jwks,'oaiapp_test','n'),/signature/);
  const expired=signedToken({...claims,exp:Math.floor(Date.now()/1000)-1});
  assert.throws(()=>verifyIdToken(expired.jwt,expired.jwks,'oaiapp_test','n'),/time/);
});
test('stream requires terminal completed event and returns real deltas',async()=>{
  const event=(x)=>`data: ${JSON.stringify(x)}\n\n`;
  async function* chunks(){const bytes=Buffer.from(event({type:'response.output_text.delta',delta:'化学'})+event({type:'response.completed'}));const i=bytes.indexOf(Buffer.from('化'))+1;yield bytes.subarray(0,i);yield bytes.subarray(i);}
  assert.equal(await readResponseStream(chunks()),'化学');
  async function* incomplete(){yield Buffer.from(event({type:'response.output_text.delta',delta:'no'}));}
  await assert.rejects(readResponseStream(incomplete()),/completed/);
  async function* failure(){yield Buffer.from(event({type:'response.failed',response:{error:{code:'subscription_sharing_user_not_eligible'}}}));}
  await assert.rejects(readResponseStream(failure()),/subscription_sharing_user_not_eligible/);
});
test('unpublished app fails closed before any file read or network',async()=>{
  await assert.rejects(runProbe({image:'missing.png',privateDir:'missing',publicReleaseConfirmed:false}),/release not confirmed/);
});
