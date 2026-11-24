// Publishes the Instagram stories in takvim.json whose time has come, then marks them in the file.
// Runs on GitHub Actions every 10 minutes (see .github/workflows/paylas.yml).
// Env: IG_TOKEN (Meta system-user token, never expires), GITHUB_REPOSITORY (set by Actions).
// Local test: DRY_RUN=1 NOW=2026-11-25T10:05:00+03:00 node paylas.js
const fs = require('fs');
const path = require('path');

const IG_ID = '17841436961662425'; // lavinyacoffeeco
const API = `https://graph.facebook.com/${process.env.IG_API_VERSION || 'v23.0'}`;
const TOKEN = process.env.IG_TOKEN;
const DRY = process.env.DRY_RUN === '1';
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const MAX_LATE_MIN = 120; // a story more than 2 hours late is skipped, not posted out of place
const TAKVIM = path.join(__dirname, 'takvim.json');

const plan = JSON.parse(fs.readFileSync(TAKVIM, 'utf8'));
const zaman = (s) => new Date(`${s.tarih}T${s.saat}:00+03:00`); // Türkiye saati (UTC+3)
const kaydet = () => fs.writeFileSync(TAKVIM, JSON.stringify(plan, null, 2) + '\n');

async function api(method, endpoint, params = {}) {
  const query = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = method === 'GET'
    ? await fetch(`${API}${endpoint}?${query}`)
    : await fetch(`${API}${endpoint}`, { method: 'POST', body: query });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json;
}

async function storyPaylas(imageUrl) {
  const { id: kapsayici } = await api('POST', `/${IG_ID}/media`, { image_url: imageUrl, media_type: 'STORIES' });
  for (let i = 0; i < 12; i++) { // wait up to ~1 minute for Instagram to process the image
    const { status_code } = await api('GET', `/${kapsayici}`, { fields: 'status_code' });
    if (status_code === 'FINISHED') break;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`Görsel işlenemedi: ${status_code}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  const { id } = await api('POST', `/${IG_ID}/media_publish`, { creation_id: kapsayici });
  return id;
}

(async () => {
  if (!DRY && !TOKEN) throw new Error('IG_TOKEN tanımlı değil');
  const zamaniGelen = plan.filter((s) => !s.paylasildi && !s.atlandi && zaman(s) <= NOW);
  if (zamaniGelen.length === 0) { console.log('Paylaşılacak story yok.'); return; }

  let hata = false;
  for (const s of zamaniGelen) {
    const gecikme = (NOW - zaman(s)) / 60000;
    if (gecikme > MAX_LATE_MIN) {
      s.atlandi = `${Math.round(gecikme)} dk gecikti, atlandı`;
      console.error(`ATLANDI: ${s.dosya} — ${s.atlandi}`);
      hata = true;
      continue;
    }
    const url = `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/main/${s.dosya}`;
    if (DRY) { console.log(`[deneme] paylaşılacaktı: ${s.tarih} ${s.saat} ${url}`); continue; }
    try {
      s.medya_id = await storyPaylas(url);
      s.paylasildi = new Date().toISOString();
      console.log(`PAYLAŞILDI: ${s.tarih} ${s.saat} ${s.dosya}`);
    } catch (e) {
      console.error(`HATA: ${s.dosya} — ${e.message}`); // retried on the next run
      hata = true;
    }
    kaydet();
  }
  if (!DRY) kaydet();
  if (hata) process.exitCode = 1; // a failed run makes GitHub email the repo owner
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
