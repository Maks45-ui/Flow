import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DIAGNOSTIC_RULES, DiagnosticHistory, diagnose, primaryErrorMessage, redactDiagnostics, buildDiagnosticReport } from '../src/diagnostics.ts';
import { withGpuFindings } from '../src/gpu-findings.ts';

test('provided Forge exit-code report finds the actual GPU error in its traceback', () => {
  const incident = new DiagnosticHistory();
  incident.record('install', 'Successfully installed torch-2.14.0+cu130');
  incident.record('install', 'RuntimeError: PyTorch is not able to access any compute device (GPU)');
  const result = incident.capture('install', 'Команда завершилась с кодом Some(1).');
  assert.equal(result.matches[0]?.rule.id, 'gpu-unavailable');
  assert.match(result.matches[0]?.evidence, /PyTorch is not able/);
  assert(!result.matches.some(match => match.rule.id === 'cuda-memory'));
});

test('CUDA driver errors have their own diagnosis and GPU errors do not match unrelated scopes', () => {
  assert.equal(diagnose('install', 'CUDA driver version is insufficient for CUDA runtime version', [])[0]?.rule.id, 'cuda-driver');
  assert.equal(diagnose('launch', 'No CUDA GPUs are available', [])[0]?.rule.id, 'gpu-unavailable');
  assert.equal(diagnose('catalog', 'No CUDA GPUs are available', []).length, 0);
});

test('missing ASUS NVIDIA gets evidence-based steps without claiming to have detected Eco Mode', () => {
  const incident = new DiagnosticHistory().capture('install', 'No CUDA GPUs are available');
  const info = { manufacturer:'ASUSTeK COMPUTER INC.', model:'TUF F15', error:null, devices:[
    {name:'NVIDIA RTX 3050',present:false,problem:45,status:'Unknown'},
    {name:'Intel Iris Xe',present:true,problem:0,status:'OK'}
  ]};
  const result = withGpuFindings(incident, info);
  assert.equal(result.matches[0]?.rule.id, 'gpu-device-state');
  assert.match(result.matches[0]?.evidence, /code=45/);
  assert.match(result.matches[0]?.rule.cause, /автоматически не определён/);
  assert(result.matches[0]?.rule.steps.some(step => step.includes('Standard')));
  const restored = withGpuFindings(incident, { ...info, devices:[{name:'NVIDIA RTX 3050',present:true,problem:0,status:'OK'}] });
  assert.equal(restored.matches[0]?.rule.id, 'gpu-unavailable');
  assert.equal(withGpuFindings(incident, {...info,error:'Access denied'}), incident);
  assert.equal(withGpuFindings(incident, {...info,devices:[...info.devices,{name:'NVIDIA RTX 3050',present:true,problem:0,status:'OK'}]}), incident);
});

test('unknown errors still show their real exception instead of a bare process exit code', () => {
  const history = new DiagnosticHistory();
  history.record('install', 'ModuleNotFoundError: No module named custom_module');
  const incident = history.capture('install', 'Команда завершилась с кодом Some(1).');
  assert.match(primaryErrorMessage(incident), /ModuleNotFoundError/);
  assert.equal(incident.matches.length, 0);
});

for (const [id, scope, input] of [
  ['cuda-memory', 'launch', 'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2 GiB'],
  ['windows-commit', 'launch', 'OSError: The paging file is too small for this operation to complete. (os error 1455)'],
  ['disk-full', 'install', 'OSError: [WinError 112] There is not enough space on the disk'],
  ['civitai-auth', 'catalog', 'HTTP status client error (401 Unauthorized) for url (https://civitai.com/api/v1/models)'],
  ['civitai-forbidden', 'download', 'HTTP status client error (403 Forbidden)'],
  ['civitai-rate-limit', 'catalog', 'HTTP status client error (429 Too Many Requests)'],
  ['request-timeout', 'download', 'error sending request: operation timed out'],
]) test(`recognizes ${id}`, () => assert.equal(diagnose(scope, input, [])[0]?.rule.id, id));

test('generic failure stays unknown', () => assert.deepEqual(diagnose('launch', 'Процесс завершился с кодом 1', []), []));
test('bare numeric identifiers are not HTTP failures', () => assert.deepEqual(diagnose('catalog', 'Downloaded model 401, seed 429', []), []));
test('does not call unrelated HTTP 401 a Civitai error', () => assert.deepEqual(diagnose('general', 'HTTP 401 Unauthorized', []), []));
test('CPU out of memory is not CUDA out of memory', () => assert.deepEqual(diagnose('launch', 'CPU allocator: out of memory', []), []));
test('explicit current error outranks earlier log signatures', () => {
 const matches = diagnose('install', 'No space left on device', ['operation timed out']);
 assert.deepEqual(matches.map(item => item.rule.id), ['disk-full']);
});
test('generic process exit uses recent operation context', () => assert.equal(diagnose('launch', 'Exit code 1', ['CUDA out of memory'])[0]?.rule.id, 'cuda-memory'));
test('limits context to last 80 lines', () => assert.deepEqual(diagnose('launch', 'Exit code 1', ['CUDA out of memory', ...Array(81).fill('ordinary log')]), []));
test('operation reset and scopes prevent stale diagnoses', () => {
 const history = new DiagnosticHistory();
 history.record('launch', 'CUDA out of memory');
 assert.equal(history.capture('download', 'Unknown').matches.length, 0);
 history.begin('launch');
 assert.equal(history.capture('launch', 'Unknown').matches.length, 0);
});
test('history is bounded and snapshots are immutable', () => {
 const history = new DiagnosticHistory();
 for (let i = 0; i < 300; i++) history.record('launch', `log ${i}`);
 const first = history.capture('launch', 'Unknown');
 assert.equal(first.lines.length, 120);
 history.record('launch', 'later');
 assert(!first.lines.includes('later'));
});
for (const [name, input, secrets] of [
 ['headers and assignments', 'Authorization: Bearer privateBearer123\nCIVITAI_API_KEY=privateKey456\n{"token":"privateJson789"}\npassword="private password"', ['privateBearer123','privateKey456','privateJson789','private password']],
 ['URLs and signed parameters', 'https://user:privatePassword@civitai.com/api/download/models/1?token=privateQuery&signature=privateSignature#privateHash', ['privatePassword','privateQuery','privateSignature','privateHash']],
 ['paths, email and prompts', 'C:\\Users\\Alice\\models\\x.safetensors\n/home/bob/models/x\nuser@example.com\nPrompt: private prompt\nNegative prompt: private negative', ['Alice','bob','user@example.com','private prompt','private negative']],
 ['home directories with spaces', 'C:\\Users\\Alice Smith\\models\\x.safetensors\n/Users/Bob Jones/models/x', ['Alice', 'Smith', 'Bob', 'Jones']],
 ['command arguments', 'command --token privateArg --api-key "private quoted key"', ['privateArg','private quoted key']],
]) test(`redacts ${name}`, () => {
 const output = redactDiagnostics(input);
 for (const secret of secrets) assert(!output.includes(secret), `${secret} leaked in ${output}`);
});
test('evidence and exported report are redacted again', () => {
 const history = new DiagnosticHistory();
 history.record('download', 'HTTP 401 Unauthorized https://civitai.com?token=privateToken');
 const incident = history.capture('download', 'HTTP 401 Unauthorized; api_key=privateKey');
 const output = buildDiagnosticReport(incident, ['Authorization: Bearer privateEnvironment']);
 for (const secret of ['privateToken','privateKey','privateEnvironment']) assert(!output.includes(secret));
 assert(output.includes('civitai-auth'));
});
test('unknown report does not invent a solution', () => {
 const output = buildDiagnosticReport(new DiagnosticHistory().capture('general','Unexpected failure'), []);
 assert(output.includes('Причина не установлена'));
});
test('every rule has reviewed provenance and an allowlisted source', () => {
 const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
 assert.equal(new Set(DIAGNOSTIC_RULES.map(rule => rule.id)).size, DIAGNOSTIC_RULES.length);
 for (const rule of DIAGNOSTIC_RULES) {
  assert.match(rule.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert(rule.appliesTo && rule.steps.length > 0);
  assert(rust.includes(`"${rule.source.url}"`), rule.source.url);
  assert.equal(new URL(rule.source.url).protocol,'https:');
 }
});

test('redacts secrets before bounding log input', () => {
 const history = new DiagnosticHistory();
 const secret = 'privateChunk'.repeat(3000);
 history.record('download', 'token=' + secret);
 const report = buildDiagnosticReport(history.capture('download', 'token=' + secret), []);
 assert(!report.includes('privateChunk'));
});
