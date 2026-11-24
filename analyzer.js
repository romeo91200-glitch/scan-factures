/*
 * Analyse d'image pour la prise de photo de factures.
 * Fonctionne sur un objet de type ImageData { data, width, height } (RGBA),
 * sans dépendance : utilisable dans le navigateur et dans Node (tests).
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    darkMean: 70,          // luminosité moyenne en dessous de laquelle c'est trop sombre
    brightMean: 225,       // luminosité moyenne au-dessus de laquelle c'est surexposé
    glareFraction: 0.12,   // part de pixels "brûlés" sur la facture => reflet
    minContrast: 35,       // écart minimal facture / fond pour détecter la facture
    minDocArea: 0.08,      // en dessous : aucune facture détectée
    smallDocArea: 0.30,    // en dessous : se rapprocher
    largeDocArea: 0.93,    // au-dessus : reculer
    centerTol: 0.10,       // décalage du centre toléré (fraction de l'image)
    maxRotationDeg: 10,    // rotation tolérée
    minSideRatio: 0.86,    // rapport côtés opposés (perspective)
    blurThreshold: 70,     // netteté minimale (net ≈ 150-300, flou < 60)
    motionThreshold: 10,   // différence moyenne entre 2 images => bouge
    segWidth: 160          // largeur de travail pour la détection de la facture
  };

  function toGray(img) {
    const { data, width, height } = img;
    const g = new Uint8ClampedArray(width * height);
    for (let i = 0, j = 0; j < g.length; i += 4, j++) {
      g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    }
    return g;
  }

  function downscale(gray, w, h, tw) {
    if (w <= tw) return { g: gray, w, h, s: 1 };
    const s = w / tw;
    const th = Math.max(1, Math.round(h / s));
    const out = new Uint8ClampedArray(tw * th);
    for (let y = 0; y < th; y++) {
      const y0 = Math.floor(y * s), y1 = Math.min(h, Math.floor((y + 1) * s));
      for (let x = 0; x < tw; x++) {
        const x0 = Math.floor(x * s), x1 = Math.min(w, Math.floor((x + 1) * s));
        let sum = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) {
          let o = yy * w;
          for (let xx = x0; xx < x1; xx++) { sum += gray[o + xx]; n++; }
        }
        out[y * tw + x] = n ? sum / n : 0;
      }
    }
    return { g: out, w: tw, h: th, s };
  }

  function boxBlur(g, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += g[y * w + xx]; n++; } }
        tmp[y * w + x] = s / n;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += tmp[yy * w + x]; n++; } }
        out[y * w + x] = s / n;
      }
    }
    return out;
  }

  function otsu(g) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    const total = g.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 127;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; t = i; }
    }
    return t;
  }

  // Plus grande composante connexe de pixels clairs (la feuille)
  function largestComponent(mask, w, h) {
    const label = new Int32Array(w * h);
    const stack = new Int32Array(w * h);
    let bestLabel = 0, bestSize = 0, cur = 0;
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i] || label[i]) continue;
      cur++;
      let sp = 0, size = 0;
      stack[sp++] = i; label[i] = cur;
      while (sp) {
        const p = stack[--sp]; size++;
        const x = p % w, y = (p - x) / w;
        if (x > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = cur; stack[sp++] = p - 1; }
        if (x < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = cur; stack[sp++] = p + 1; }
        if (y > 0 && mask[p - w] && !label[p - w]) { label[p - w] = cur; stack[sp++] = p - w; }
        if (y < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = cur; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; bestLabel = cur; }
    }
    return { label, id: bestLabel, size: bestSize };
  }

  function polyArea(q) {
    let a = 0;
    for (let i = 0; i < 4; i++) { const p = q[i], n = q[(i + 1) % 4]; a += p.x * n.y - n.x * p.y; }
    return Math.abs(a) / 2;
  }
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Netteté : force des bords les plus nets (0,5 % des pixels de plus fort laplacien)
  // rapportée à l'amplitude de gris de la facture. Indépendant de la lumière et de la
  // quantité de texte ; chute fortement quand l'image est floue ou bougée.
  function edgeSharpness(g, w, h, box) {
    const x0 = Math.max(1, box.x0), x1 = Math.min(w - 2, box.x1);
    const y0 = Math.max(1, box.y0), y1 = Math.min(h - 2, box.y1);
    const lh = new Uint32Array(1021), gh = new Uint32Array(256);
    let n = 0;
    for (let y = y0; y <= y1; y++) {
      const o = y * w;
      for (let x = x0; x <= x1; x++) {
        const i = o + x;
        const v = Math.abs(g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i]);
        lh[v]++; gh[g[i]]++; n++;
      }
    }
    if (n < 100) return 0;
    const pct = (hist, p) => { let c = 0; const t = n * p; for (let i = 0; i < hist.length; i++) { c += hist[i]; if (c >= t) return i; } return hist.length - 1; };
    const range = pct(gh, 0.98) - pct(gh, 0.02);
    if (range < 20) return 0;
    // moyenne du top 0,5 %
    let need = Math.max(1, Math.round(n * 0.005)), sum = 0, got = 0;
    for (let i = 1020; i >= 0 && got < need; i--) { const k = Math.min(lh[i], need - got); sum += k * i; got += k; }
    return 100 * (sum / got) / range;
  }

  /**
   * Analyse une image et renvoie l'état + les consignes.
   * @param img ImageData-like
   * @param prevSmall image réduite précédente (pour détecter le mouvement)
   */
  function analyze(img, opts, prevSmall) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const { width: W, height: H } = img;
    const gray = toGray(img);

    // 1. Luminosité globale
    let mean = 0;
    for (let i = 0; i < gray.length; i++) mean += gray[i];
    mean /= gray.length;

    // 2. Détection de la facture sur image réduite
    const small = downscale(gray, W, H, o.segWidth);
    const sw = small.w, sh = small.h;
    const blurred = boxBlur(small.g, sw, sh, 2);
    const t = otsu(blurred);
    const mask = new Uint8Array(sw * sh);
    let fgSum = 0, fgN = 0, bgSum = 0, bgN = 0;
    for (let i = 0; i < blurred.length; i++) {
      if (blurred[i] > t) { mask[i] = 1; fgSum += blurred[i]; fgN++; } else { bgSum += blurred[i]; bgN++; }
    }
    const contrast = (fgN ? fgSum / fgN : 0) - (bgN ? bgSum / bgN : 0);

    // Mouvement
    let motion = 0;
    if (prevSmall && prevSmall.length === small.g.length) {
      for (let i = 0; i < small.g.length; i++) motion += Math.abs(small.g[i] - prevSmall[i]);
      motion /= small.g.length;
    }

    const result = {
      ok: false,
      brightness: Math.round(mean),
      contrast: Math.round(contrast),
      motion: +motion.toFixed(1),
      sharpness: 0,
      quad: null,              // coins normalisés [0..1] : tl, tr, br, bl
      issues: [],              // [{code, message}] par ordre de priorité
      small: small.g
    };
    const issue = (code, message) => result.issues.push({ code, message });

    if (mean < o.darkMean) issue('dark', 'Pas assez de lumière : allumez une lampe ou activez le flash');
    else if (mean > o.brightMean) issue('bright', 'Trop de lumière : évitez la lumière directe sur la facture');

    let doc = null;
    if (contrast >= o.minContrast) {
      const comp = largestComponent(mask, sw, sh);
      if (comp.size / (sw * sh) >= o.minDocArea) {
        let tl, tr, br, bl, minX = sw, maxX = 0, minY = sh, maxY = 0, sx = 0, sy = 0;
        let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
        let touch = { left: 0, right: 0, top: 0, bottom: 0 };
        for (let y = 0; y < sh; y++) {
          for (let x = 0; x < sw; x++) {
            if (comp.label[y * sw + x] !== comp.id) continue;
            sx += x; sy += y;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            const s = x + y, d = x - y;
            if (s < sMin) { sMin = s; tl = { x, y }; }
            if (s > sMax) { sMax = s; br = { x, y }; }
            if (d > dMax) { dMax = d; tr = { x, y }; }
            if (d < dMin) { dMin = d; bl = { x, y }; }
            if (x === 0) touch.left++; if (x === sw - 1) touch.right++;
            if (y === 0) touch.top++; if (y === sh - 1) touch.bottom++;
          }
        }
        const norm = p => ({ x: (p.x + 0.5) / sw, y: (p.y + 0.5) / sh });
        const quad = [tl, tr, br, bl].map(norm);
        doc = {
          quad,
          area: polyArea(quad),
          cx: sx / comp.size / sw,
          cy: sy / comp.size / sh,
          touch: {
            left: touch.left > sh * 0.15, right: touch.right > sh * 0.15,
            top: touch.top > sw * 0.15, bottom: touch.bottom > sw * 0.15
          },
          box: { x0: minX, x1: maxX, y0: minY, y1: maxY }
        };
        result.quad = quad;
      }
    }

    if (!doc) {
      issue('nodoc', 'Aucune facture détectée : cadrez-la entièrement, posée sur un fond plus sombre');
    } else {
      // Reflet sur la facture
      let burnt = 0, n = 0;
      const b = doc.box;
      for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) { n++; if (small.g[y * sw + x] >= 250) burnt++; }
      if (n && burnt / n > o.glareFraction) issue('glare', 'Reflet sur la facture : inclinez légèrement la lumière ou changez de place');

      const T = doc.touch;
      const nTouch = (T.left ? 1 : 0) + (T.right ? 1 : 0) + (T.top ? 1 : 0) + (T.bottom ? 1 : 0);
      if (doc.area > o.largeDocArea || nTouch >= 3 || (T.left && T.right) || (T.top && T.bottom)) {
        issue('tooclose', 'Trop près : reculez le téléphone pour voir toute la facture');
      } else if (nTouch > 0) {
        // La facture dépasse d'un côté : déplacer le téléphone de ce côté
        const dirs = [];
        if (T.left) dirs.push('vers la gauche');
        if (T.right) dirs.push('vers la droite');
        if (T.top) dirs.push('vers le haut');
        if (T.bottom) dirs.push('vers le bas');
        issue('cut', 'La facture est coupée : déplacez le téléphone ' + dirs.join(' et '));
      } else if (doc.area < o.smallDocArea) {
        issue('far', 'Trop loin : rapprochez le téléphone de la facture');
      }

      if (nTouch === 0) {
        const dx = doc.cx - 0.5, dy = doc.cy - 0.5;
        const dirs = [];
        if (dx < -o.centerTol) dirs.push('vers la gauche');
        else if (dx > o.centerTol) dirs.push('vers la droite');
        if (dy < -o.centerTol) dirs.push('vers le haut');
        else if (dy > o.centerTol) dirs.push('vers le bas');
        if (dirs.length) issue('offcenter', 'Centrez la facture : déplacez le téléphone ' + dirs.join(' et '));

        const [qtl, qtr, qbr, qbl] = doc.quad.map(p => ({ x: p.x * W, y: p.y * H }));
        const angTop = Math.atan2(qtr.y - qtl.y, qtr.x - qtl.x) * 180 / Math.PI;
        const angBot = Math.atan2(qbr.y - qbl.y, qbr.x - qbl.x) * 180 / Math.PI;
        const rot = (angTop + angBot) / 2;
        if (Math.abs(rot) > o.maxRotationDeg) {
          issue('rotated', 'Tournez le téléphone ' + (rot > 0 ? 'vers la droite' : 'vers la gauche') + ' pour aligner la facture avec l\'écran');
        } else {
          const top = dist(qtl, qtr), bottom = dist(qbl, qbr), left = dist(qtl, qbl), right = dist(qtr, qbr);
          const v = Math.min(top, bottom) / Math.max(top, bottom);
          const hz = Math.min(left, right) / Math.max(left, right);
          if (v < o.minSideRatio || hz < o.minSideRatio) {
            let detail;
            if (v <= hz) detail = top < bottom ? 'le haut de la facture est plus loin que le bas' : 'le bas de la facture est plus loin que le haut';
            else detail = left < right ? 'le côté gauche est plus loin que le droit' : 'le côté droit est plus loin que le gauche';
            issue('tilted', 'Mettez le téléphone bien à plat au-dessus de la facture (' + detail + ')');
          }
        }
      }

      // Netteté mesurée sur la facture, à pleine résolution d'analyse
      const s = W / sw;
      const box = { x0: Math.round(b.x0 * s), x1: Math.round(b.x1 * s), y0: Math.round(b.y0 * s), y1: Math.round(b.y1 * s) };
      result.sharpness = Math.round(edgeSharpness(gray, W, H, box));
    }

    if (prevSmall && motion > o.motionThreshold) issue('motion', 'Ne bougez plus : tenez le téléphone immobile');
    else if (doc && result.sharpness < o.blurThreshold) issue('blur', 'Photo floue : tenez le téléphone immobile, à 20-30 cm de la facture');

    result.ok = result.issues.length === 0;
    if (result.ok) result.issues.push({ code: 'ok', message: 'Parfait, ne bougez plus !' });
    return result;
  }

  // ---- Redressement de la facture (homographie) ----
  function solve(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let max = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[max][i])) max = r;
      [A[i], A[max]] = [A[max], A[i]]; [b[i], b[max]] = [b[max], b[i]];
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }

  // Homographie qui envoie les points src[i] sur dst[i]
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i], { x: u, y: v } = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = solve(A, b);
    return [...h, 1];
  }

  /**
   * Redresse la zone quad (coins en pixels tl,tr,br,bl) de src (ImageData) et renvoie un ImageData-like.
   */
  function warp(src, quad, makeImageData) {
    const [tl, tr, br, bl] = quad;
    const outW = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
    const outH = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
    const H = homography(
      [{ x: 0, y: 0 }, { x: outW - 1, y: 0 }, { x: outW - 1, y: outH - 1 }, { x: 0, y: outH - 1 }],
      [tl, tr, br, bl]
    );
    const out = makeImageData(outW, outH);
    const sd = src.data, od = out.data, sw = src.width, shh = src.height;
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const w = H[6] * x + H[7] * y + H[8];
        const fx = (H[0] * x + H[1] * y + H[2]) / w;
        const fy = (H[3] * x + H[4] * y + H[5]) / w;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const o = (y * outW + x) * 4;
        if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= shh - 1) { od[o] = od[o + 1] = od[o + 2] = 255; od[o + 3] = 255; continue; }
        const ax = fx - x0, ay = fy - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        for (let c = 0; c < 3; c++) {
          od[o + c] = (sd[i00 + c] * (1 - ax) + sd[i10 + c] * ax) * (1 - ay) + (sd[i01 + c] * (1 - ax) + sd[i11 + c] * ax) * ay;
        }
        od[o + 3] = 255;
      }
    }
    return out;
  }

  const api = { analyze, warp, homography, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.InvoiceAnalyzer = api;
})(typeof self !== 'undefined' ? self : this);
