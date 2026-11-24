// Tests de l'analyse sur des images synthétiques : node test/analyzer.test.js
const A = require('../analyzer.js');
const assert = require('assert');

const W = 360, H = 480;

function inside(q, x, y) {
  // point dans un quadrilatère convexe (sens horaire tl,tr,br,bl)
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false;
  }
  return true;
}

// Génère une "facture" : feuille claire avec des lignes de texte, sur fond sombre.
function makeInvoice({ quad, bg = 70, paper = 235, light = 1, blur = 0, noiseSeed = 1 } = {}) {
  quad = quad || [{ x: 60, y: 70 }, { x: 300, y: 70 }, { x: 300, y: 410 }, { x: 60, y: 410 }];
  const H0 = A.homography(quad, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
  let seed = noiseSeed;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const words = [];
  for (let line = 0; line < 30; line++) {
    let u = 0.08;
    while (u < 0.9) { const len = 0.03 + rnd() * 0.08; words.push([line, u, Math.min(u + len, 0.92)]); u += len + 0.02; }
  }
  let g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = bg;
    if (inside(quad, x, y)) {
      const w = H0[6] * x + H0[7] * y + H0[8];
      const u = (H0[0] * x + H0[1] * y + H0[2]) / w, vv = (H0[3] * x + H0[4] * y + H0[5]) / w;
      v = paper;
      const line = Math.floor((vv - 0.08) / 0.028);
      const inLine = vv > 0.08 && ((vv - 0.08) % 0.028) < 0.012;
      if (inLine && words.some(([l, a, b]) => l === line && u >= a && u <= b)) v = 30;
    }
    g[y * W + x] = v * light;
  }
  for (let k = 0; k < blur; k++) {
    const o = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += g[(y + dy) * W + x + dx];
      o[y * W + x] = s / 9;
    }
    g = o;
  }
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = g[i]; data[i * 4 + 3] = 255; }
  return { data, width: W, height: H };
}

const codes = r => r.issues.map(i => i.code);
let failed = 0;
function check(name, img, expect, prev) {
  const r = A.analyze(img, null, prev);
  const c = codes(r);
  const pass = expect(c, r);
  console.log((pass ? '✓ ' : '✗ ') + name.padEnd(38) + ' → ' + r.issues.map(i => i.message).join(' | ') +
    `  [lum ${r.brightness}, net ${r.sharpness}, contraste ${r.contrast}]`);
  if (!pass) failed++;
  return r;
}

check('Facture bien cadrée', makeInvoice(), c => c[0] === 'ok');
[1,2,3,4].forEach(b=>check('Facture floue (niveau '+b+')', makeInvoice({ blur: b }), c=>c.includes('blur')));
check('Facture floue', makeInvoice({ blur: 4 }), c => c.includes('blur'));
check('Trop sombre', makeInvoice({ light: 0.3 }), c => c[0] === 'dark');
check('Facture trop petite (loin)', makeInvoice({ quad: [{ x: 130, y: 170 }, { x: 230, y: 170 }, { x: 230, y: 310 }, { x: 130, y: 310 }] }), c => c.includes('far'));
check('Facture à gauche', makeInvoice({ quad: [{ x: 10, y: 70 }, { x: 230, y: 70 }, { x: 230, y: 410 }, { x: 10, y: 410 }] }),
  (c, r) => c.includes('offcenter') && /gauche/.test(r.issues.find(i => i.code === 'offcenter').message));
check('Facture coupée à droite', makeInvoice({ quad: [{ x: 150, y: 70 }, { x: 420, y: 70 }, { x: 420, y: 410 }, { x: 150, y: 410 }] }),
  (c, r) => c.includes('cut') && /droite/.test(r.issues[0].message));
check('Trop près', makeInvoice({ quad: [{ x: -20, y: -20 }, { x: 380, y: -20 }, { x: 380, y: 500 }, { x: -20, y: 500 }], bg: 70 }), c => c.includes('tooclose') || c.includes('nodoc'));
check('Téléphone incliné (perspective)', makeInvoice({ quad: [{ x: 110, y: 80 }, { x: 250, y: 80 }, { x: 320, y: 400 }, { x: 40, y: 400 }] }),
  (c, r) => c.includes('tilted') && /haut/.test(r.issues.find(i => i.code === 'tilted').message));
check('Facture tournée', makeInvoice({ quad: [{ x: 110, y: 50 }, { x: 320, y: 120 }, { x: 250, y: 430 }, { x: 40, y: 360 }] }), c => c.includes('rotated'));
check('Pas de facture (fond uni)', makeInvoice({ quad: [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.1, y: 0.1 }, { x: 0, y: 0.1 }] }), c => c.includes('nodoc'));
const a = makeInvoice(), b = makeInvoice({ quad: [{ x: 75, y: 90 }, { x: 315, y: 90 }, { x: 315, y: 430 }, { x: 75, y: 430 }] });
const r1 = A.analyze(a);
check('Mouvement entre deux images', b, c => c.includes('motion'), r1.small);

// Redressement
const img = makeInvoice({ quad: [{ x: 110, y: 80 }, { x: 250, y: 80 }, { x: 320, y: 400 }, { x: 40, y: 400 }] });
const out = A.warp(img, [{ x: 110, y: 80 }, { x: 250, y: 80 }, { x: 320, y: 400 }, { x: 40, y: 400 }],
  (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }));
const corner = out.data[(2 * out.width + 2) * 4];
console.log((corner > 200 ? '✓ ' : '✗ ') + `Redressement ${out.width}x${out.height}, coin = papier (${corner})`);
if (corner <= 200) failed++;

console.log(failed ? `\n${failed} test(s) en échec` : '\nTous les tests passent');
process.exit(failed ? 1 : 0);
