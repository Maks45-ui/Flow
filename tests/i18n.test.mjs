import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

async function setup(saved) {
  const window = new Window({ url: 'http://localhost' });
  window.document.write(readFileSync(new URL('../index.html', import.meta.url), 'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
  for (const key of ['window', 'document', 'localStorage', 'Text', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'HTMLDialogElement', 'HTMLSelectElement']) globalThis[key] = key === 'window' ? window : window[key];
  if (saved !== undefined) localStorage.setItem('flow.language', saved);
  const api = await import(`../src/i18n.ts?test=${Math.random()}`);
  api.initializeLanguage();
  return { window, api, document: window.document };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

test('first-run language choice blocks until saved and persists across launches', async () => {
  const { window, api, document } = await setup();
  let finished = false;
  const choice = api.chooseFirstLanguage().then(() => { finished = true; });
  await flush();
  assert.equal(document.querySelector('#language-dialog').open, true);
  assert.equal(finished, false);
  document.querySelector('[data-language=en]').click();
  await choice;
  assert.equal(localStorage.getItem('flow.language'), 'en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(document.querySelector('#language-dialog').open, false);
  assert.match(document.querySelector('#first-run-title').textContent, /Before you start/);
  await window.happyDOM.close();
  const next = await setup('en');
  await next.api.chooseFirstLanguage();
  assert.equal(next.document.querySelector('#language-dialog').open, false);
  await next.window.happyDOM.close();
});

test('switches static, accessible and asynchronously rendered copy both ways without replacing controls', async () => {
  const { window, api, document } = await setup('ru');
  const button = document.querySelector('#refresh-gallery');
  let clicks = 0;
  button.addEventListener('click', () => clicks++);
  api.setLanguage('en');
  assert.equal(button.getAttribute('aria-label'), 'Refresh gallery');
  const status = document.createElement('p');
  status.textContent = 'Осталось: ~3 мин';
  document.body.append(status);
  await flush();
  assert.equal(status.textContent, 'Remaining: ~3 min');
  status.textContent = 'Скачивается';
  await flush();
  assert.equal(status.textContent, 'Downloading');
  document.querySelector('#language-select').value = 'ru';
  document.querySelector('#language-select').dispatchEvent(new window.Event('change'));
  assert.equal(status.textContent, 'Скачивается');
  assert.equal(button.getAttribute('aria-label'), 'Обновить галерею');
  assert.equal(button, document.querySelector('#refresh-gallery'));
  button.click();
  assert.equal(clicks, 1);
  await window.happyDOM.close();
});

test('preserves prompts, paths, model names, input values and raw process logs', async () => {
  const { window, api, document } = await setup('ru');
  document.querySelector('#inspector-prompt').textContent = 'Розовая Модель';
  document.querySelector('#terminal-log').setAttribute('translate', 'no');
  document.querySelector('#terminal-log').textContent = '[WebUI] Ошибка: Модель';
  document.querySelector('#token-input').value = 'Русский secret';
  const name = document.createElement('h2'); name.setAttribute('translate', 'no'); name.textContent = 'Розовая'; document.body.append(name);
  api.setLanguage('en');
  assert.equal(document.querySelector('#inspector-prompt').textContent, 'Розовая Модель');
  assert.equal(document.querySelector('#terminal-log').textContent, '[WebUI] Ошибка: Модель');
  assert.equal(document.querySelector('#token-input').value, 'Русский secret');
  assert.equal(name.textContent, 'Розовая');
  assert.equal(api.translate('секунда и модельный'), 'секунда и модельный');
  await window.happyDOM.close();
});

test('does not dismiss the language chooser if persistence fails', async () => {
  const { window, api, document } = await setup('unsupported');
  const original = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => original.getItem(key), setItem: () => { throw new Error('storage unavailable'); } };
  let finished = false;
  void api.chooseFirstLanguage().then(() => { finished = true; });
  document.querySelector('[data-language=ru]').click();
  await flush();
  assert.equal(finished, false);
  assert.equal(document.querySelector('#language-dialog').open, true);
  assert.match(document.querySelector('.language-error').textContent, /Could not save/);
  globalThis.localStorage = original;
  await window.happyDOM.close();
});
