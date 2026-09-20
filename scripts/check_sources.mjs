// Garde-fou de la CI : aucune constante climatique ni aucun domaine reseau imprevu dans le
// code client. Toute valeur de rechauffement doit venir de data/baselines.json.
//
// Usage : node scripts/check_sources.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['assets/js'];
const ALLOWED_HOSTS = [
  'api.open-meteo.com',
  'archive-api.open-meteo.com',
  'geocoding-api.open-meteo.com',
  'open-meteo.com',
  'berkeleyearth.org',
  'www.geonames.org',
  'json-schema.org',
  'www.w3.org',
  'github.com',
];

// Une constante climatique = un nombre de degres accole a un vocabulaire de rechauffement.
const CLIMATE_CONSTANT = /\b\d+[.,]\d+\s*(?:°\s*C|degres?|degrees?)\b|\b(?:pre[-_ ]?industr|prei|warming|rechauffement)\w*\s*[:=]\s*-?\d+[.,]\d+|-?\d+[.,]\d+\s*(?:°\s*C)?\s*(?:de\s+)?(?:rechauffement|warming)/i;
const URL_RE = /https?:\/\/([a-z0-9.-]+)/gi;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const problems = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    let inBlockComment = false;
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      // Les commentaires sont ignores : ils documentent la methode, ils ne la parametrent pas.
      let code = line;
      if (inBlockComment) {
        const end = code.indexOf('*/');
        if (end === -1) code = '';
        else {
          code = code.slice(end + 2);
          inBlockComment = false;
        }
      }
      const blockStart = code.indexOf('/*');
      if (blockStart !== -1) {
        const end = code.indexOf('*/', blockStart + 2);
        if (end === -1) {
          code = code.slice(0, blockStart);
          inBlockComment = true;
        } else {
          code = code.slice(0, blockStart) + code.slice(end + 2);
        }
      }
      const lineComment = code.indexOf('//');
      if (lineComment !== -1 && !/https?:$/.test(code.slice(0, lineComment))) code = code.slice(0, lineComment);

      // Les bornes de palette et les libelles d'interface ne sont pas des constantes climatiques :
      // on ne signale que les valeurs decimales associees au vocabulaire du rechauffement.
      if (CLIMATE_CONSTANT.test(code) && !/DOMAIN|palette|legend|fmtTemp|fmtSigned/i.test(code)) {
        problems.push(`${rel}:${i + 1} constante climatique suspecte : ${trimmed.slice(0, 120)}`);
      }
      let match;
      URL_RE.lastIndex = 0;
      while ((match = URL_RE.exec(line)) !== null) {
        const host = match[1].toLowerCase();
        if (!ALLOWED_HOSTS.includes(host)) {
          problems.push(`${rel}:${i + 1} domaine non autorise : ${host}`);
        }
      }
    });
  }
}

// Le fichier de references doit exister et porter sa provenance.
try {
  const baselines = JSON.parse(readFileSync(join(ROOT, 'data', 'baselines.json'), 'utf8'));
  for (const [slug, region] of Object.entries(baselines.regions || {})) {
    for (const key of ['source_url', 'pre_window', 'ref_window', 'fetched_at', 'licence']) {
      if (region[key] === undefined || region[key] === null) {
        problems.push(`data/baselines.json : region ${slug} sans ${key}`);
      }
    }
  }
} catch (err) {
  problems.push(`data/baselines.json illisible : ${err.message}`);
}

if (problems.length) {
  console.error('Controle des sources : echec');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('Controle des sources : aucune constante climatique codee en dur, aucun domaine imprevu.');
