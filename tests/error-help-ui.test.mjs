import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';

test('error help opens on the real traceback, shows GPU status, and can check again', async () => {
  const window = new Window();
  globalThis.document = window.document;
  globalThis.MutationObserver = window.MutationObserver;
  document.write(readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
  let source = readFileSync(new URL('../src/error-help.ts', import.meta.url), 'utf8')
    .replace('import { version } from "../package.json";', 'const version = "test";');
  for (const name of ['diagnostics','gpu-findings']) source = source.replaceAll(`from "./${name}"`, `from "${new URL(`../src/${name}.ts`, import.meta.url).href}"`);
  const compiled = ts.transpileModule(source, { compilerOptions: {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext} }).outputText;
  const { withErrorHelp } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  let receiveTask;
  let checks = 0;
  const api = withErrorHelp({
    onTask: async callback => { receiveTask = callback; return () => {}; },
    installForgeNeo: async () => {
      receiveTask({kind:'install',phase:'log',message:'RuntimeError: PyTorch is not able to access any compute device (GPU)'});
      throw new Error('Команда завершилась с кодом Some(1).');
    },
    getState: async () => ({packages:[]}),
    getPreflight: async () => ({checks:[]}),
    getWebUIStatus: async () => ({running:false,vramTotalGb:null}),
    getGpuDiagnostics: async () => ({manufacturer:'ASUSTeK',model:'TUF F15',error:null,devices:[{name:'NVIDIA RTX 3050',present:++checks > 1,problem:checks > 1 ? 0 : 45,status:checks > 1 ? 'OK':'Unknown'}]})
  });
  await assert.rejects(api.installForgeNeo('D:/Flow'));
  document.querySelector('#console-error-help').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(document.querySelector('#error-help-dialog').open, true);
  assert.match(document.querySelector('#error-help-message').textContent, /PyTorch is not able/);
  assert.match(document.querySelector('#error-help-findings').textContent, /Standard/);
  assert.match(document.querySelector('#error-help-findings').textContent, /не подключена; код: 45/);
  assert.match(document.querySelector('#error-help-report').value, /gpu-device-state/);
  document.querySelector('#retry-error-check').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(checks, 2);
  assert.match(document.querySelector('#error-help-findings').textContent, /подключена; код: 0/);
  assert(!document.querySelector('#error-help-findings').textContent.includes('Windows не видит NVIDIA как подключённое устройство'));
  await window.happyDOM.close();
});
