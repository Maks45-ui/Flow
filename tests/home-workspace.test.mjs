import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

test('Home keeps progress, recent images and logs in a bounded workspace without embedded editors', async () => {
  const window = new Window();
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  window.document.write(html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''));
  const document = window.document;
  const home = document.querySelector('#page-home');
  for (const id of ['package-list', 'generation-track', 'home-recent-grid', 'console-panel']) {
    assert(home.contains(document.getElementById(id)), id);
  }
  assert.equal(document.querySelector('iframe'), null);
  assert(document.querySelector('option[value="amdgpu-forge-install"]'));
  assert.equal(document.querySelector('option[value="comfyui-install"]'), null);
  assert.equal(document.querySelector('#generation-notifications'), null);
  const style = document.createElement('style');
  style.textContent = readFileSync(new URL('../src/home-workspace.css', import.meta.url), 'utf8');
  document.head.append(style);
  assert.equal(window.getComputedStyle(home).overflow, 'hidden');
  assert.equal(window.getComputedStyle(home).gridTemplateRows, 'minmax(0, 1fr)');
  assert.equal(window.getComputedStyle(document.querySelector('#home-overview')).overflow, 'hidden');
  await window.happyDOM.close();
});
