import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import ts from 'typescript';

// Compile the component as Vite does; Node's type stripping cannot erase constructor properties.
const source = readFileSync(new URL('../src/comfy-home.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { ComfyHome, localComfyUrl } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('only accepts loopback HTTP roots with an explicit port', () => {
  assert.equal(localComfyUrl('http://127.0.0.1:8189'), 'http://127.0.0.1:8189/');
  for (const url of ['https://127.0.0.1:8188', 'http://example.com:8188', 'http://127.0.0.1:8188@evil.com', 'http://127.0.0.1', 'file:///D:/ComfyUI', 'http://127.0.0.1:8188/private']) {
    assert.throws(() => localComfyUrl(url));
  }
});

test('embeds inside Home, preserves the overview and clears the frame on stop', async () => {
  const window = new Window();
  globalThis.document = window.document;
  document.write(readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
  let home = 0, stops = 0, restarts = 0;
  const view = new ComfyHome(() => home++, () => stops++, () => restarts++, async () => 200);
  const overview = document.querySelector('#home-overview');
  const frame = document.querySelector('#comfy-frame');
  assert.equal(document.querySelector('#page-home').contains(frame), true);
  assert.equal(document.querySelector('#page-home').contains(overview), true);
  view.sync([{ id: 'comfyui', running: true, stopping: false, readyUrl: 'http://127.0.0.1:8188' }]);
  document.querySelector('#home-comfy-tab').click();
  await Promise.resolve();
  assert.equal(home, 1);
  assert.equal(overview.hidden, true);
  assert.equal(document.querySelector('#comfy-panel').hidden, false);
  assert.equal(frame.getAttribute('src'), 'http://127.0.0.1:8188/');
  assert.equal(frame.referrerPolicy, 'origin');
  frame.dispatchEvent(new window.Event('load'));
  assert.equal(document.querySelector('#comfy-status').hidden, true);
  assert.equal(frame.hidden, false);
  document.querySelector('#home-overview-tab').click();
  assert.equal(overview.hidden, false);
  assert.equal(frame.getAttribute('src'), 'http://127.0.0.1:8188/');
  document.querySelector('#home-comfy-tab').click();
  assert.equal(overview.hidden, true);
  document.querySelector('#comfy-stop').click();
  document.querySelector('#comfy-restart').click();
  assert.equal(stops, 1); assert.equal(restarts, 1);
  view.sync([]);
  assert.equal(frame.hasAttribute('src'), false);
  assert.equal(document.querySelector('#home-comfy-tab').disabled, true);
  assert.equal(overview.hidden, false);
  assert.equal(document.querySelector('#home-overview'), overview);
  await window.happyDOM.close();
});

test('shows a restart action for a forbidden embed instead of a white iframe; reload retries', async () => {
  const window = new Window();
  globalThis.document = window.document;
  document.write(readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
  let code = 403;
  const view = new ComfyHome(() => {}, () => {}, () => {}, async () => code);
  view.open('http://127.0.0.1:8188/');
  await Promise.resolve();
  const frame = document.querySelector('#comfy-frame');
  assert.equal(frame.hidden, true);
  assert.equal(frame.hasAttribute('src'), false);
  assert.match(document.querySelector('#comfy-status').textContent, /403.*Перезапустить/);
  code = 200;
  document.querySelector('#comfy-reload').click();
  await Promise.resolve();
  assert.equal(frame.getAttribute('src'), 'http://127.0.0.1:8188/');
  frame.dispatchEvent(new window.Event('load'));
  assert.equal(frame.hidden, false);
  view.sync([]);
  await window.happyDOM.close();
});

test('ignores a pending probe after stop, and reports connection errors', async () => {
  const window = new Window();
  globalThis.document = window.document;
  document.write(readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
  let resolve;
  const view = new ComfyHome(() => {}, () => {}, () => {}, () => new Promise(done => { resolve = done; }));
  view.open('http://127.0.0.1:8188/');
  view.sync([]);
  resolve(200);
  await Promise.resolve();
  assert.equal(document.querySelector('#comfy-frame').hasAttribute('src'), false);
  const failed = new ComfyHome(() => {}, () => {}, () => {}, async () => { throw new Error('Connection refused'); });
  failed.open('http://127.0.0.1:8188/');
  await Promise.resolve();
  assert.match(document.querySelector('#comfy-status').textContent, /Connection refused/);
  failed.sync([]);
  await window.happyDOM.close();
});
