import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';

const flush = () => new Promise(resolve => setTimeout(resolve, 20));

async function setup(initialStage) {
  const window = new Window({ url: 'http://localhost' });
  window.document.write(readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
  for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'Element', 'Node', 'Text', 'NodeFilter', 'MutationObserver', 'HTMLDialogElement', 'CustomEvent']) {
    globalThis[key] = key === 'window' ? window : window[key];
  }
  localStorage.setItem('flow.language', 'ru');
  sessionStorage.setItem('flow.splash.seen', '1');
  let source = readFileSync(new URL('../src/onboarding.ts', import.meta.url), 'utf8');
  for (const name of ['splash', 'i18n', 'onboarding-copy']) {
    source = source.replaceAll(`from "./${name}"`, `from "${new URL(`../src/${name}.ts`, import.meta.url).href}"`);
  }
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { FirstRunController } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${Math.random()}`);
  const state = { stage: initialStage, saved: [], catalogRequests: 0, downloads: 0, completed: 0, awaitingInstallation: 0 };
  const api = {
    getOnboardingStage: async () => state.stage,
    saveOnboardingToken: async token => { state.saved.push(token); state.stage = state.afterKeyStage ?? 1; },
    getStarterModel: async () => {
      state.catalogRequests++;
      return { file: { name: 'test.safetensors' }, previewUrl: null };
    },
    finishOnboarding: async () => { state.stage = 3; }
  };
  const app = document.getElementById('app-shell');
  const dialog = document.getElementById('first-run-dialog');
  const controller = new FirstRunController(api, app, () => { state.downloads++; return 'task'; },
    () => state.completed++, () => state.awaitingInstallation++);
  return { window, state, app, dialog, controller };
}

test('startup never opens model selection or requests models for a pending installation/model step', async () => {
  for (const stage of [1, 2, 3]) {
    const context = await setup(stage);
    await context.controller.start();
    assert.equal(context.app.inert, false);
    assert.equal(context.dialog.open, false);
    assert.equal(context.state.catalogRequests, 0);
    assert.equal(context.state.downloads, 0);
    await context.window.happyDOM.close();
  }
});

test('saving or skipping the first API key opens Home even if a package is already installed', async () => {
  for (const token of ['sample-key', null]) {
    const context = await setup(0);
    context.state.afterKeyStage = 2;
    await context.controller.start();
    assert.equal(context.dialog.open, true);
    if (token === null) document.getElementById('first-run-skip').click();
    else {
      document.getElementById('first-run-token').value = token;
      document.getElementById('first-run-form').dispatchEvent(new context.window.Event('submit', { cancelable: true }));
    }
    await flush();
    assert.deepEqual(context.state.saved, [token]);
    assert.equal(context.dialog.open, false);
    assert.equal(context.app.inert, false);
    assert.equal(context.state.catalogRequests, 0);
    assert.equal(context.state.downloads, 0);
    await context.window.happyDOM.close();
  }
});

test('optional model selection remains available only after a successful package installation', async () => {
  const context = await setup(0);
  await context.controller.start();
  document.getElementById('first-run-skip').click();
  await flush();
  assert.equal(context.state.awaitingInstallation, 1);
  await context.controller.onInstallComplete();
  assert.equal(context.dialog.open, false);
  assert.equal(context.state.catalogRequests, 0);
  context.state.stage = 2;
  await context.controller.onInstallComplete();
  await flush();
  assert.equal(context.dialog.open, true);
  assert.equal(document.getElementById('first-run-model-step').hidden, false);
  assert.equal(context.state.catalogRequests, 3);
  assert.equal(context.state.downloads, 0);
  document.getElementById('first-run-model-skip').click();
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(context.state.stage, 3);
  assert.equal(context.dialog.open, false);
  assert.equal(context.app.inert, false);
  assert.equal(context.state.completed, 1);
  await context.window.happyDOM.close();
});
