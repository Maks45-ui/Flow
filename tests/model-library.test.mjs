import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';

const flush = () => new Promise(resolve => setTimeout(resolve, 20));
const compile = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext } }).outputText).toString('base64')}`;

async function setup(freeBytes) {
  const window = new Window({ url:'http://localhost' });
  for (const key of ['window','document','localStorage','Text','Element','Node','NodeFilter','MutationObserver','CustomEvent']) globalThis[key] = key === 'window' ? window : window[key];
  localStorage.setItem('flow.language','ru');
  let source = readFileSync(new URL('../src/download-destination.ts',import.meta.url),'utf8')
    .replace('import "./model-library.css";','')
    .replace('from "./i18n"',`from "${new URL('../src/i18n.ts',import.meta.url).href}"`);
  const destinationModule = compile(source);
  source = readFileSync(new URL('../src/download-manager.ts',import.meta.url),'utf8')
    .replace('from "./download-destination"',`from "${destinationModule}"`);
  const {DownloadManager} = await import(compile(source));
  const calls = [];
  const api = {
    getDownloadDestination: async () => ({directory:'D:\\Flow\\models\\Stable-diffusion',freeBytes,requiredBytes:1024 ** 3}),
    downloadModel: async (...args) => calls.push(args)
  };
  const manager = new DownloadManager(api,document.createElement('div'),document.createElement('div'),()=>{});
  return {window,manager,calls};
}

test('download requires explicit confirmation of the real target and pins that path for Rust',async()=>{
  const {window,manager,calls} = await setup(10 * 1024 ** 3);
  const file = {name:'example.safetensors',downloadUrl:'https://civitai.red/api/download/models/1',sizeKb:1024 ** 2,sha256:null};
  const queued = manager.enqueue(file,'Checkpoint','Example');
  await flush();
  assert.equal(calls.length,0);
  assert.match(document.querySelector('.library-path').textContent,/D:.*Stable-diffusion/);
  document.querySelector('.download-destination .primary-button').click();
  assert(await queued);
  await flush();
  assert.equal(calls.length,1);
  assert.equal(calls[0][4],'D:\\Flow\\models\\Stable-diffusion');
  await window.happyDOM.close();
});

test('insufficient space blocks approval and cancellation starts no transfer',async()=>{
  const {window,manager,calls} = await setup(1024);
  const queued = manager.enqueue({name:'large.safetensors',downloadUrl:'url',sizeKb:1024 ** 2,sha256:null},'Checkpoint','Large');
  await flush();
  assert.equal(document.querySelector('.download-destination .primary-button').disabled,true);
  document.querySelector('.download-destination .secondary-button').click();
  assert.equal(await queued,null);
  assert.equal(calls.length,0);
  await window.happyDOM.close();
});
