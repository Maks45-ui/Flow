import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Window } from 'happy-dom';

async function setup(saved = {}) {
  const window = new Window({url:'http://localhost'});
  globalThis.document = window.document;
  globalThis.localStorage = window.localStorage;
  document.write(readFileSync(new URL('../index.html',import.meta.url),'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g,''));
  for (const [key,value] of Object.entries(saved)) localStorage.setItem(key,value);
  const source = readFileSync(new URL('../src/snow.ts',import.meta.url),'utf8').replace('import "./snow.css";','');
  const compiled = ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const {initializeSnow} = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  initializeSnow();
  return {window,initializeSnow};
}

test('snow sliders update immediately, retain existing flakes and save their values',async()=>{
  const {window,initializeSnow} = await setup();
  const overlay = document.getElementById('flow-snow');
  const first = overlay.firstElementChild;
  const density = document.getElementById('snow-intensity');
  const size = document.getElementById('snow-size');
  assert.equal(overlay.childElementCount,24);
  density.value = '60'; density.dispatchEvent(new window.Event('input'));
  assert.equal(overlay.childElementCount,60);
  assert.equal(overlay.firstElementChild,first);
  size.value = '6'; size.dispatchEvent(new window.Event('input'));
  assert.equal(overlay.style.getPropertyValue('--snow-size'),'6px');
  assert.equal(overlay.firstElementChild,first);
  density.value = '12'; density.dispatchEvent(new window.Event('input'));
  assert.equal(overlay.childElementCount,12);
  assert.equal(localStorage.getItem('flow.snow.intensity'),'12');
  assert.equal(localStorage.getItem('flow.snow.size'),'6');
  const toggle = document.getElementById('snow-enabled');
  toggle.checked = false; toggle.dispatchEvent(new window.Event('change'));
  assert.equal(overlay.hidden,true);
  assert.equal(density.disabled,true);
  assert.equal(size.disabled,true);
  toggle.checked = true; toggle.dispatchEvent(new window.Event('change'));
  assert.equal(overlay.childElementCount,12);
  assert.equal(size.value,'6');
  initializeSnow();
  assert.equal(document.querySelectorAll('#flow-snow').length,1);
  await window.happyDOM.close();
});

test('snow restores saved settings and safely rejects corrupted or excessive values',async()=>{
  for (const [saved,count,pixels,hidden] of [
    [{'flow.snow.enabled':'false','flow.snow.intensity':'48','flow.snow.size':'5'},48,'5px',true],
    [{'flow.snow.intensity':'999999','flow.snow.size':'NaN'},24,'3px',false],
    [{'flow.snow.intensity':'13','flow.snow.size':''},24,'3px',false]
  ]) {
    const {window} = await setup(saved);
    const overlay = document.getElementById('flow-snow');
    assert.equal(overlay.childElementCount,count);
    assert.equal(overlay.style.getPropertyValue('--snow-size'),pixels);
    assert.equal(overlay.hidden,hidden);
    await window.happyDOM.close();
  }
});
