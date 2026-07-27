// Runs every test suite found in tests/*.test.mjs and reports a combined result.
// Suites are added by different agents working in parallel, so this discovers them
// rather than hard-coding a list.
import { readdirSync } from 'fs';
import { spawnSync } from 'child_process';

const suites = readdirSync(new URL('.', import.meta.url))
  .filter(f => f.endsWith('.test.mjs')).sort();

let failed = 0;
const results = [];
for (const s of suites) {
  const r = spawnSync(process.execPath, [`tests/${s}`], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = (out.match(/\[ OK \]/g) || []).length;
  const bad = (out.match(/\[FAIL\]/g) || []).length;
  const crashed = r.status !== 0 && bad === 0;
  if (r.status !== 0) failed++;
  results.push({ s, ok, bad, crashed, status: r.status });
  if (r.status !== 0) {
    console.log(`\n----- ${s} FAILED -----`);
    console.log(out.split('\n').filter(l => l.includes('[FAIL]') || l.includes('Error')).slice(0, 20).join('\n'));
  }
}
console.log('\n=============== SUITE SUMMARY ===============');
for (const r of results)
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'}  ${r.s.padEnd(24)} ${String(r.ok).padStart(4)} ok  ${r.bad} failing${r.crashed ? '  (CRASHED)' : ''}`);
const totalOk = results.reduce((a, r) => a + r.ok, 0);
console.log(`\n${failed === 0 ? 'ALL SUITES PASSED' : failed + ' SUITE(S) FAILING'} — ${totalOk} checks total`);
process.exit(failed === 0 ? 0 : 1);
