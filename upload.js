// Envoi des photos au serveur de réception, qui les range dans le dossier du client.
// Deux serveurs possibles, même protocole :
//  - le logiciel de compta (lien généré dans Paramètres > Application photo : ?c=CODE&s=ADRESSE_DU_LOGICIEL),
//    qui transmet à Google Drive, OneDrive ou au NAS choisi pour le client ;
//  - à défaut, le serveur Google Apps Script de config.js (UPLOAD_URL).
// Le client n'a besoin d'aucun compte.
(function () {
  'use strict';
  const cfg = window.APP_CONFIG || {};
  const KEY = 'client_code';
  const SRV_KEY = 'server_url';

  // ---- Adresse du logiciel de compta : lue dans le lien (?s=…) puis mémorisée ----
  function cleanServer(s) {
    s = String(s || '').trim().replace(/\/+$/, '');
    return /^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(s) || /^http:\/\/localhost(:\d+)?$/.test(s) ? s : '';
  }
  function readServer() {
    const fromUrl = cleanServer(new URLSearchParams(location.search).get('s'));
    if (fromUrl) { try { localStorage.setItem(SRV_KEY, fromUrl); } catch (e) {} return fromUrl; }
    try { return cleanServer(localStorage.getItem(SRV_KEY)); } catch (e) { return ''; }
  }
  const server = readServer();
  const endpoint = () => (server ? server + '/api/app-photo' : (cfg.UPLOAD_URL || ''));

  // ---- Code client : lu dans le lien (?c=CODE) puis mémorisé sur le téléphone ----
  function readCode() {
    const fromUrl = new URLSearchParams(location.search).get('c');
    if (fromUrl) { try { localStorage.setItem(KEY, fromUrl.trim().toUpperCase()); } catch (e) {} }
    try { return (fromUrl || localStorage.getItem(KEY) || '').trim().toUpperCase(); } catch (e) { return (fromUrl || '').toUpperCase(); }
  }
  let code = readCode();

  function setCode(c) {
    code = String(c || '').trim().toUpperCase();
    try { localStorage.setItem(KEY, code); } catch (e) {}
    installManifest();
  }

  // Manifeste personnalisé : l'app installée sur l'écran d'accueil garde le code client.
  function installManifest() {
    if (!code) return;
    const base = new URL('./', location.href).href;
    const m = {
      name: 'Scan Factures', short_name: 'Factures', lang: 'fr', display: 'standalone', orientation: 'portrait',
      background_color: '#0f172a', theme_color: '#0f172a',
      id: base, scope: base, start_url: base + '?c=' + encodeURIComponent(code) + (server ? '&s=' + encodeURIComponent(server) : ''),
      icons: [
        { src: base + 'icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: base + 'icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: base + 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    };
    const link = document.querySelector('link[rel="manifest"]');
    if (link) link.href = 'data:application/manifest+json,' + encodeURIComponent(JSON.stringify(m));
  }
  installManifest();

  function configured() { return !!endpoint(); }

  // Vérifie le code auprès du serveur : { ok, client } ou { ok:false, error }
  async function check() {
    if (!configured()) return { ok: false, error: 'Application non configurée (adresse du serveur manquante)' };
    if (!code) return { ok: false, error: 'nocode' };
    const r = await fetch(endpoint() + '?action=check&c=' + encodeURIComponent(code));
    return r.json();
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  async function upload(blob, name, clientCode) {
    const data = await blobToBase64(blob);
    // text/plain : requête « simple », sans pré-vérification CORS (exigé par Apps Script, accepté par le logiciel)
    const r = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ c: clientCode || code, name, mime: blob.type || 'image/jpeg', data })
    });
    const res = await r.json();
    if (!res.ok) throw Object.assign(new Error(res.error || 'Erreur serveur'), { refused: true });
    return res;
  }

  // ---- File d'attente hors-ligne (IndexedDB) : rien n'est perdu sans réseau ----
  function db() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('scan-factures', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('queue', mode), st = t.objectStore('queue');
      const req = fn(st);
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
    });
  }
  const queue = {
    add: (blob, name) => tx('readwrite', st => st.add({ blob, name, c: code, at: Date.now() })),
    all: () => tx('readonly', st => st.getAll()),
    remove: id => tx('readwrite', st => st.delete(id))
  };

  let flushing = false;
  async function flush() {
    if (flushing || !configured() || !navigator.onLine) return 0;
    flushing = true;
    let sent = 0;
    try {
      for (const it of await queue.all()) {
        await upload(it.blob, it.name, it.c || code);
        await queue.remove(it.id);
        sent++;
      }
    } finally { flushing = false; }
    return sent;
  }

  window.Uploader = { configured, check, upload, queue, flush, getCode: () => code, setCode };
})();
