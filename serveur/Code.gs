/**
 * Scan Factures : serveur de réception des photos (Google Apps Script)
 *
 * À coller dans une Google Sheet : Extensions > Apps Script.
 * Les photos envoyées par les clients arrivent dans VOTRE Drive, dans le dossier
 * indiqué pour chaque client dans l'onglet « Clients ». Les clients n'ont pas
 * besoin de compte Google.
 *
 * Colonnes de l'onglet « Clients » :
 *   A Nom du client | B Code | C Dossier Drive | D Lien à envoyer au client | E Actif | F Photos reçues | G Dernier envoi
 */

const SHEET = 'Clients';
const HEADERS = ['Nom du client', 'Code', 'Dossier Drive (lien)', 'Lien à envoyer au client', 'Actif (oui/non)', 'Photos reçues', 'Dernier envoi'];
const COL = { name: 1, code: 2, folder: 3, link: 4, active: 5, count: 6, last: 7 };
const PARENT_FOLDER_NAME = 'Factures clients';
const MAX_BYTES = 15 * 1024 * 1024;

// ---------------------------------------------------------------- Menu

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Factures')
    .addItem('1. Installer (première fois)', 'installer')
    .addItem('2. Régler l\'adresse de l\'application', 'reglerAdresseApp')
    .addSeparator()
    .addItem('Préparer les nouveaux clients (dossiers + liens)', 'preparerClients')
    .addSeparator()
    .addItem('Relier au logiciel de compta', 'relierLogicielCompta')
    .addToUi();
}

function installer() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET);
  if (!sh) sh = ss.insertSheet(SHEET, 0);
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold').setBackground('#e2e8f0');
  sh.setFrozenRows(1);
  sh.setColumnWidth(COL.name, 180); sh.setColumnWidth(COL.folder, 320); sh.setColumnWidth(COL.link, 380);
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(['oui', 'non'], true).build();
  sh.getRange(2, COL.active, 500, 1).setDataValidation(rule);
  parentFolder_();
  SpreadsheetApp.getUi().alert(
    'Installation terminée.\n\n' +
    'Étape suivante : Déployer > Nouveau déploiement > Application Web\n' +
    '  • Exécuter en tant que : Moi\n' +
    '  • Qui a accès : Tout le monde\n\n' +
    'Puis menu Factures > Régler l\'adresse de l\'application.');
}

function reglerAdresseApp() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const cur = props.getProperty('APP_URL') || '';
  const r = ui.prompt('Adresse de l\'application',
    'Collez l\'adresse où l\'app est publiée (ex. https://moncompte.github.io/scan-factures/).\nActuelle : ' + (cur || '(aucune)'),
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  let url = r.getResponseText().trim();
  if (!/^https:\/\//.test(url)) { ui.alert('L\'adresse doit commencer par https://'); return; }
  if (!url.endsWith('/') && !/\.html$/.test(url)) url += '/';
  props.setProperty('APP_URL', url);
  preparerClients();
}

/**
 * Pour chaque ligne avec un nom : crée le code, le dossier (si la colonne C est vide)
 * et le lien à envoyer. Pour changer le dossier d'un client, collez simplement
 * le lien d'un autre dossier dans la colonne C : son lien d'app reste le même.
 */
function preparerClients() {
  const sh = sheet_();
  const appUrl = PropertiesService.getScriptProperties().getProperty('APP_URL');
  const last = sh.getLastRow();
  if (last < 2) { toast_('Ajoutez d\'abord un nom de client en colonne A.'); return; }
  const range = sh.getRange(2, 1, last - 1, HEADERS.length);
  const rows = range.getValues();
  const existing = new Set(rows.map(r => String(r[COL.code - 1]).trim()).filter(Boolean));
  let n = 0;
  rows.forEach((r, i) => {
    const name = String(r[COL.name - 1]).trim();
    if (!name) return;
    let changed = false;
    if (!String(r[COL.code - 1]).trim()) {
      let code; do { code = newCode_(name); } while (existing.has(code));
      existing.add(code); r[COL.code - 1] = code; changed = true;
    }
    if (!String(r[COL.folder - 1]).trim()) {
      const f = parentFolder_().createFolder(name);
      r[COL.folder - 1] = f.getUrl(); changed = true;
    }
    if (appUrl) {
      const link = appUrl + '?c=' + encodeURIComponent(r[COL.code - 1]);
      if (r[COL.link - 1] !== link) { r[COL.link - 1] = link; changed = true; }
    }
    if (!String(r[COL.active - 1]).trim()) { r[COL.active - 1] = 'oui'; changed = true; }
    if (r[COL.count - 1] === '') r[COL.count - 1] = 0;
    if (changed) n++;
  });
  range.setValues(rows);
  toast_(n ? n + ' client(s) prêt(s).' + (appUrl ? '' : ' Réglez l\'adresse de l\'app pour obtenir les liens.') : 'Rien à faire : tous les clients sont prêts.');
}

// ---------------------------------------------------------------- Web app

// Vérifie un code client : GET ?action=check&c=CODE
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'check') {
    const c = findClient_(p.c);
    if (!c) return json_({ ok: false, error: 'Lien client inconnu ou désactivé' });
    return json_({ ok: true, client: c.name });
  }
  return json_({ ok: true, service: 'scan-factures' });
}

// Reçoit une photo : POST { c, name, mime, data (base64) }
// ou, de la part du logiciel de compta : POST { action: 'relais', secret, dossier, name, mime, data }
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.action === 'relais') return json_(relais_(body));
    const c = findClient_(body.c);
    if (!c) return json_({ ok: false, error: 'Lien client inconnu ou désactivé' });
    const mime = /^image\/(jpeg|png)$/.test(body.mime) ? body.mime : 'image/jpeg';
    const bytes = Utilities.base64Decode(body.data);
    if (bytes.length > MAX_BYTES) return json_({ ok: false, error: 'Photo trop lourde' });
    const name = safeName_(body.name) || ('Facture_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HH-mm-ss') + '.jpg');
    const folder = folderFrom_(c.folder);
    const file = folder.createFile(Utilities.newBlob(bytes, mime, name));

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sh = sheet_();
      const cnt = sh.getRange(c.row, COL.count);
      cnt.setValue((Number(cnt.getValue()) || 0) + 1);
      sh.getRange(c.row, COL.last).setValue(new Date());
    } finally { lock.releaseLock(); }

    return json_({ ok: true, id: file.getId(), name: name });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ---------------------------------------------------------------- Logiciel de compta

/**
 * Le logiciel de compta (Paramètres du dossier > Application photo) reçoit les photos
 * des clients et, pour la destination « Google Drive », les fait écrire ici, dans VOTRE
 * Drive, dans le dossier choisi pour le client. Protégé par un secret partagé.
 */
function relierLogicielCompta() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('RELAIS_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('RELAIS_SECRET', secret);
  }
  const url = ScriptApp.getService().getUrl() || '(déployez d\'abord : Déployer > Nouveau déploiement > Application Web)';
  ui.alert('Relier au logiciel de compta',
    'Sur Render (service logiciel-compta > Environment), ajoutez :\n\n' +
    'APP_PHOTO_GOOGLE_URL = ' + url + '\n\n' +
    'APP_PHOTO_GOOGLE_SECRET = ' + secret + '\n\n' +
    'puis Save Changes. Gardez ce secret pour vous.', ui.ButtonSet.OK);
}

function relais_(body) {
  const attendu = PropertiesService.getScriptProperties().getProperty('RELAIS_SECRET');
  if (!attendu || String(body.secret || '') !== attendu) return { ok: false, error: 'Secret invalide : menu Factures > Relier au logiciel de compta' };
  let folder;
  try { folder = folderFrom_(String(body.dossier || '')); } catch (err) { return { ok: false, error: 'Dossier Drive introuvable ou sans accès' }; }
  const mime = /^(image\/(jpeg|png)|text\/plain)$/.test(body.mime) ? body.mime : 'image/jpeg';
  const bytes = Utilities.base64Decode(String(body.data || ''));
  if (!bytes.length) return { ok: false, error: 'Fichier vide' };
  if (bytes.length > MAX_BYTES) return { ok: false, error: 'Photo trop lourde' };
  const name = String(body.name || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || ('Facture_' + Date.now() + '.jpg');
  const file = folder.createFile(Utilities.newBlob(bytes, mime, name));
  return { ok: true, id: file.getId(), name: name };
}

// ---------------------------------------------------------------- Outils

function sheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET);
  if (!sh) throw new Error('Onglet « Clients » introuvable : lancez Factures > Installer');
  return sh;
}

function findClient_(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return null;
  const sh = sheet_();
  const last = sh.getLastRow();
  if (last < 2) return null;
  const rows = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[COL.code - 1]).trim().toUpperCase() !== code) continue;
    if (String(r[COL.active - 1]).trim().toLowerCase() === 'non') return null;
    if (!String(r[COL.folder - 1]).trim()) return null;
    return { row: i + 2, name: String(r[COL.name - 1]).trim(), folder: String(r[COL.folder - 1]).trim() };
  }
  return null;
}

function folderFrom_(link) {
  const m = link.match(/folders\/([\w-]{10,})/) || link.match(/[?&]id=([\w-]{10,})/) || link.match(/^([\w-]{10,})$/);
  if (!m) throw new Error('Lien de dossier invalide : ' + link);
  return DriveApp.getFolderById(m[1]);
}

function parentFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PARENT_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const it = DriveApp.getFoldersByName(PARENT_FOLDER_NAME);
  const f = it.hasNext() ? it.next() : DriveApp.createFolder(PARENT_FOLDER_NAME);
  props.setProperty('PARENT_FOLDER_ID', f.getId());
  return f;
}

// Code lisible et impossible à deviner, ex. DUPONT-7K3QX9
function newCode_(name) {
  const base = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'CLIENT';
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return base + '-' + s;
}

function safeName_(n) {
  n = String(n || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  return /\.(jpe?g|png)$/i.test(n) ? n : '';
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function toast_(msg) {
  try { SpreadsheetApp.getActive().toast(msg, 'Factures', 6); } catch (e) {}
}
