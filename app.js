(function () {
  'use strict';
  const cfg = window.APP_CONFIG || {};
  const $ = id => document.getElementById(id);
  const video = $('video'), overlay = $('overlay'), work = $('work');
  const octx = overlay.getContext('2d');
  const wctx = work.getContext('2d', { willReadFrequently: true });

  const ANALYSIS_WIDTH = 360;
  const OK_FRAMES_FOR_AUTO = 4;     // ~0,6 s d'image stable et correcte
  const opts = { blurThreshold: cfg.BLUR_THRESHOLD || 70 };

  let stream = null, track = null, running = false, prevSmall = null;
  let okStreak = 0, lastResult = null, torchOn = false;
  let currentBlob = null, currentName = '';

  // ---------- Caméra ----------
  async function startCamera() {
    $('startError').textContent = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }
      });
    } catch (e) {
      $('startOverlay').hidden = false;
      $('startError').textContent = e.name === 'NotAllowedError'
        ? 'Accès à la caméra refusé. Autorisez-le dans les réglages du navigateur, puis réessayez.'
        : 'Caméra indisponible (' + e.name + '). L\'app doit être ouverte en https.';
      return;
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    track = stream.getVideoTracks()[0];
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.torch) $('btnTorch').hidden = false;
      if (caps.focusMode && caps.focusMode.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    } catch (e) {}
    $('startOverlay').hidden = true;
    running = true;
    loop();
  }

  function stopLoop() { running = false; }

  // L'aperçu montre toute l'image de la caméra (comme l'app photo native),
  // pour que ce que l'utilisateur voit soit exactement ce qui est analysé et envoyé.
  function layout() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const top = $('guide').getBoundingClientRect().bottom + 8;
    const bottom = $('btnShoot').getBoundingClientRect().top - 12;
    const availW = window.innerWidth, availH = Math.max(100, bottom - top);
    const s = Math.min(availW / vw, availH / vh);
    const w = vw * s, h = vh * s;
    for (const el of [video, overlay]) {
      Object.assign(el.style, { width: w + 'px', height: h + 'px', left: (availW - w) / 2 + 'px', top: top + (availH - h) / 2 + 'px' });
    }
  }
  window.addEventListener('resize', layout);
  video.addEventListener('loadedmetadata', layout);

  function visibleCrop() {
    return { x: 0, y: 0, w: video.videoWidth, h: video.videoHeight };
  }

  function loop() {
    if (!running) return;
    if (video.readyState >= 2 && video.videoWidth) {
      if (video.videoWidth !== loop.vw || video.videoHeight !== loop.vh) { loop.vw = video.videoWidth; loop.vh = video.videoHeight; layout(); }
      const c = visibleCrop();
      const w = ANALYSIS_WIDTH, h = Math.round(ANALYSIS_WIDTH * c.h / c.w);
      work.width = w; work.height = h;
      wctx.drawImage(video, c.x, c.y, c.w, c.h, 0, 0, w, h);
      const img = wctx.getImageData(0, 0, w, h);
      const r = InvoiceAnalyzer.analyze(img, opts, prevSmall);
      prevSmall = r.small;
      lastResult = r;
      render(r);
      if (r.ok) {
        okStreak++;
        if ($('autoCapture').checked && $('codeOverlay').hidden && okStreak >= OK_FRAMES_FOR_AUTO) { okStreak = 0; capture(); return; }
      } else okStreak = 0;
    }
    setTimeout(() => requestAnimationFrame(loop), 120);
  }

  function render(r) {
    const g = $('guide');
    g.className = 'guide ' + (r.ok ? 'ok' : (['dark', 'nodoc', 'blur'].includes(r.issues[0].code) ? 'bad' : 'warn'));
    $('guideMain').textContent = r.issues[0].message;
    $('guideMore').textContent = r.issues.slice(1, 3).map(i => '• ' + i.message).join('  ');
    const btn = $('btnShoot');
    btn.classList.toggle('ready', r.ok);
    btn.classList.toggle('counting', r.ok && $('autoCapture').checked);

    const dpr = window.devicePixelRatio || 1;
    const W = overlay.clientWidth, H = overlay.clientHeight;
    if (overlay.width !== W * dpr) { overlay.width = W * dpr; overlay.height = H * dpr; }
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, W, H);
    if (r.quad) {
      octx.beginPath();
      r.quad.forEach((p, i) => (i ? octx.lineTo : octx.moveTo).call(octx, p.x * W, p.y * H));
      octx.closePath();
      octx.lineWidth = 4;
      octx.strokeStyle = r.ok ? '#22c55e' : '#f59e0b';
      octx.fillStyle = r.ok ? 'rgba(34,197,94,.15)' : 'rgba(245,158,11,.10)';
      octx.fill(); octx.stroke();
    }
  }

  // ---------- Prise de vue ----------
  function fileName() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `Facture_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.jpg`;
  }

  function canvasToBlob(canvas) {
    return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
  }

  async function capture() {
    if (!video.videoWidth) return;
    stopLoop();
    try { navigator.userActivation && navigator.userActivation.hasBeenActive && navigator.vibrate(60); } catch (e) {}
    const c = visibleCrop();
    const full = document.createElement('canvas');
    full.width = Math.round(c.w); full.height = Math.round(c.h);
    const fctx = full.getContext('2d');
    fctx.drawImage(video, c.x, c.y, c.w, c.h, 0, 0, full.width, full.height);
    await finishCapture(full, lastResult);
  }

  async function finishCapture(full, result) {
    let outCanvas = full;
    let info = [];
    if ($('autoCrop').checked && result && result.quad && result.issues[0].code !== 'nodoc') {
      const fctx = full.getContext('2d');
      const src = fctx.getImageData(0, 0, full.width, full.height);
      const quad = result.quad.map(p => ({ x: p.x * full.width, y: p.y * full.height }));
      const out = InvoiceAnalyzer.warp(src, quad, (w, h) => fctx.createImageData(w, h));
      outCanvas = document.createElement('canvas');
      outCanvas.width = out.width; outCanvas.height = out.height;
      outCanvas.getContext('2d').putImageData(out, 0, 0);
      info.push('Facture recadrée et redressée');
    }
    if (result && !result.ok) info.push('⚠ ' + result.issues[0].message);
    currentBlob = await canvasToBlob(outCanvas);
    currentName = fileName();
    $('previewImg').src = URL.createObjectURL(currentBlob);
    $('previewInfo').textContent = info.join(' · ') + (info.length ? ' · ' : '') + Math.round(currentBlob.size / 1024) + ' Ko';
    show('preview');
  }

  function show(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
    if (id === 'camera' && stream) { prevSmall = null; okStreak = 0; running = true; loop(); }
  }

  // Import d'une photo déjà prise (galerie) : même analyse et redressement
  async function importFile(file) {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    const full = document.createElement('canvas');
    full.width = img.naturalWidth; full.height = img.naturalHeight;
    full.getContext('2d').drawImage(img, 0, 0);
    const w = ANALYSIS_WIDTH, h = Math.round(w * full.height / full.width);
    work.width = w; work.height = h;
    wctx.drawImage(full, 0, 0, w, h);
    const r = InvoiceAnalyzer.analyze(wctx.getImageData(0, 0, w, h), opts);
    await finishCapture(full, r);
  }

  // ---------- Envoi ----------
  function toast(msg, ms = 3000) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
  }

  async function refreshBadge() {
    try {
      const n = (await Uploader.queue.all()).length;
      $('queueBadge').hidden = !n;
      $('queueBadge').textContent = n + (n > 1 ? ' photos en attente' : ' photo en attente');
    } catch (e) {}
  }

  async function flushQueue() {
    try {
      const n = await Uploader.flush();
      if (n) toast(n > 1 ? `${n} factures envoyées ✔` : 'Facture envoyée ✔');
    } catch (e) {
      toast(e.refused ? 'Envoi refusé : ' + e.message : 'Pas de réseau : la photo partira dès que possible');
    }
    refreshBadge();
  }

  function onSend() {
    const blob = currentBlob, name = currentName;
    if (!blob) return;
    if (!Uploader.getCode()) { askCode('Entrez votre code client pour envoyer la photo.'); return; }
    // D'abord en file d'attente (rien n'est perdu sans réseau), puis envoi.
    Uploader.queue.add(blob, name).then(refreshBadge).then(flushQueue);
    show('camera');
    toast('Envoi en cours…', 1500);
  }

  // ---------- Client ----------
  async function checkClient() {
    const pill = $('btnDrive');
    if (!Uploader.getCode()) { askCode(); return; }
    pill.textContent = 'Vérification du lien…';
    try {
      const r = await Uploader.check();
      if (r.ok) {
        pill.textContent = 'Envoi vers : ' + r.client;
        pill.classList.add('connected');
        $('codeOverlay').hidden = true;
        flushQueue();
      } else {
        pill.textContent = 'Lien non valide';
        pill.classList.remove('connected');
        askCode(r.error === 'nocode' ? '' : r.error + '. Vérifiez votre code ou contactez la personne qui vous a envoyé l\'application.');
      }
    } catch (e) {
      // Hors-ligne : on garde le code connu, les photos attendront
      pill.textContent = 'Hors-ligne · code ' + Uploader.getCode();
    }
  }

  function askCode(msg) {
    $('codeOverlay').hidden = false;
    $('codeError').textContent = msg || '';
    $('codeInput').value = Uploader.getCode();
  }

  // ---------- Événements ----------
  $('btnStart').onclick = startCamera;
  $('btnShoot').onclick = capture;
  $('btnRetake').onclick = () => show('camera');
  $('btnSend').onclick = onSend;
  $('fileInput').onchange = e => e.target.files[0] && importFile(e.target.files[0]);
  $('btnDrive').onclick = () => askCode();
  $('btnCode').onclick = () => { Uploader.setCode($('codeInput').value); checkClient(); };
  $('btnTorch').onclick = () => {
    torchOn = !torchOn;
    track && track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => toast('Flash indisponible'));
    $('btnTorch').textContent = torchOn ? 'Flash ✔' : 'Flash';
  };
  window.addEventListener('online', flushQueue);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) flushQueue(); });

  checkClient();
  refreshBadge();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // Démarrage : on tente directement, sinon bouton (iOS exige parfois un geste)
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) startCamera();
  else { $('startOverlay').hidden = false; $('startError').textContent = 'Ce navigateur ne permet pas d\'utiliser la caméra. Utilisez Chrome (Android) ou Safari (iPhone).'; }
})();
