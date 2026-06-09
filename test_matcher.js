// test_matcher.js — batch-run the stress-test questions and print how each routes.
// Usage: node test_matcher.js   (needs OPENAI_API_KEY in .env)
require('dotenv').config();
const fs = require('fs');
const { matchQuestion } = require('./matcher');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const DELAY = Number(process.env.TEST_DELAY_MS || 350);   // throttle between calls (avoid rate limits)

(async () => {
  const items = JSON.parse(fs.readFileSync(__dirname + '/stress_test.json', 'utf8'));
  const bands = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, ERR: 0 };
  const rows = [];
  console.log(`Running ${items.length} stress-test questions (model from .env, ${DELAY}ms apart)...\n`);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    let m = null, err = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { m = await matchQuestion(it.q); err = null; break; }
      catch (e) { err = e.message; if (attempt === 0) await sleep(2500); }   // back off once, then give up
    }
    if (!m) {
      bands.ERR++;
      console.log(`[${(it.section || '?').padEnd(2)}] ERR        | ${it.q}  (${err})`);
      rows.push({ section: it.section, q: it.q, matched_id: null, band: 'ERR', refusal_tier: null, error: err });
    } else {
      bands[m.band] = (bands[m.band] || 0) + 1;
      const id = String(m.matched_id || ('REFUSE' + (m.refusal_tier || '')));
      console.log(`[${(it.section || '?').padEnd(2)}] b${m.band}  ${id.padEnd(8)} | ${it.q}`);
      rows.push({ section: it.section, q: it.q, ...m });
    }
    await sleep(DELAY);
  }
  console.log('\nBand distribution:', bands, `(of ${items.length})`);
  fs.writeFileSync(__dirname + '/stress_test_results.json', JSON.stringify(rows, null, 2));
  console.log('Full results written to stress_test_results.json');
})();
