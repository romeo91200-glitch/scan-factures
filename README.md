# Scan Factures

Application mobile (Android et iPhone, sans passer par les stores) que vous donnez à vos clients pour photographier leurs factures.

- **Consignes en direct** dans le viseur : manque de lumière, reflet, photo floue, téléphone qui bouge, facture trop loin ou trop près, coupée, pas centrée (« déplacez le téléphone vers la droite »), tournée, téléphone pas à plat (« mettez le téléphone bien à plat au-dessus de la facture »).
- **Déclenchement automatique** quand tout est bon, puis **recadrage et redressement** de la facture.
- **Chaque client a son propre lien.** Ses photos arrivent dans **son dossier, sur votre Google Drive**. Le client n'a pas besoin de compte Google.
- **Vous choisissez le dossier de chaque client** dans une Google Sheet, et vous pouvez le changer quand vous voulez sans renvoyer de lien.
- **Sans réseau**, les photos attendent sur le téléphone et partent dès que la connexion revient.

## Comment ça marche

```
 Téléphone du client                 Votre compte Google
 ┌────────────────────┐   photo   ┌──────────────────────────┐      ┌────────────────────────┐
 │ App Scan Factures  │ ────────▶ │ Petit serveur Apps Script │ ───▶ │ Drive : dossier du     │
 │ lien ...?c=DUPONT-…│           │ (lit la feuille Clients)  │      │ client « Dupont »      │
 └────────────────────┘           └──────────────────────────┘      └────────────────────────┘
```

Le code dans le lien (`?c=DUPONT-7K3QX9`) identifie le client. Le serveur cherche ce code dans la feuille « Clients » et range la photo dans le dossier indiqué sur la même ligne.

## Mise en route (une seule fois, environ 10 minutes)

### 1. Le serveur de réception (Google Sheet + Apps Script)

1. Créez une **Google Sheet** vide, nommée par exemple « Scan Factures – Clients ».
2. Menu **Extensions → Apps Script**. Effacez le contenu, collez tout le fichier [`serveur/Code.gs`](serveur/Code.gs), puis enregistrez (icône disquette).
3. Revenez dans la feuille et rechargez la page : un menu **Factures** apparaît.
4. **Factures → 1. Installer**. Google demande d'autoriser le script : choisissez votre compte, puis *Paramètres avancés → Accéder à Scan Factures (non sécurisé) → Autoriser*. C'est votre propre script, cet avertissement est normal.
5. Dans Apps Script : **Déployer → Nouveau déploiement → ⚙ → Application Web**
   - *Exécuter en tant que* : **Moi**
   - *Qui a accès* : **Tout le monde**
   - **Déployer**, puis copiez l'**URL de l'application Web** (elle se termine par `/exec`).
6. Collez cette URL dans `config.js` → `UPLOAD_URL` (ou envoyez-la à Claude, qui le fera).

### 2. Le site de l'application (GitHub Pages)

Dans le dépôt GitHub : **Settings → Pages → Source : Deploy from a branch → Branch : `main` / `(root)` → Save**.
L'app est alors en ligne à l'adresse `https://romeo91200-glitch.github.io/scan-factures/`.

Puis dans la feuille : **Factures → 2. Régler l'adresse de l'application** et collez cette adresse.

## Ajouter un client

1. Dans l'onglet **Clients**, écrivez le nom du client en colonne A.
2. **Factures → Préparer les nouveaux clients.** Le script crée :
   - un **code** unique (colonne B) ;
   - un **dossier** à son nom dans « Factures clients » sur votre Drive (colonne C) ;
   - le **lien à envoyer au client** (colonne D).
3. Envoyez ce lien au client (SMS, WhatsApp, e-mail).

| Nom du client | Code | Dossier Drive | Lien à envoyer | Actif | Photos reçues | Dernier envoi |
|---|---|---|---|---|---|---|
| Dupont SARL | DUPONT-7K3QX9 | https://drive.google.com/drive/folders/… | https://…/scan-factures/?c=DUPONT-7K3QX9 | oui | 12 | 24/11/2026 14:32 |

**Changer le dossier d'un client** : collez le lien d'un autre dossier Drive en colonne C. Le lien du client ne change pas, les prochaines photos iront dans le nouveau dossier.
**Utiliser un dossier existant** : collez son lien en colonne C *avant* de cliquer sur « Préparer les nouveaux clients ».
**Couper l'accès d'un client** : mettez `non` dans la colonne « Actif ».

## Installation chez le client

### Android (Chrome)
1. Ouvrir le lien reçu dans **Chrome**, autoriser la caméra.
2. Menu **⋮ → Installer l'application** (ou « Ajouter à l'écran d'accueil »).

### iPhone (Safari)
1. Ouvrir le lien reçu dans **Safari**, autoriser la caméra.
2. Bouton **Partager** → **Sur l'écran d'accueil** → **Ajouter**.

Si l'app installée ne retrouve pas le code, elle le demande : il figure à la fin du lien (`DUPONT-7K3QX9`).

## Utilisation

1. Poser la facture à plat, de préférence sur un **fond sombre**.
2. Suivre la consigne affichée en haut. Le cadre devient **vert** quand tout est bon.
3. En mode **Auto**, la photo se prend toute seule, sinon appuyer sur le gros bouton.
4. Vérifier l'aperçu puis **Envoyer**.

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css` | Écrans (viseur, aperçu, saisie du code) |
| `analyzer.js` | Analyse d'image : flou, lumière, détection de la facture, consignes, redressement |
| `app.js` | Caméra, boucle d'analyse, prise de vue, aperçu |
| `upload.js` | Code client, envoi au serveur, file d'attente hors-ligne |
| `config.js` | Adresse du serveur, sensibilité au flou |
| `serveur/Code.gs` | Serveur Apps Script à coller dans la Google Sheet |
| `manifest.webmanifest`, `sw.js`, `icon*` | Installation sur l'écran d'accueil, hors-ligne |
| `test/analyzer.test.js` | Tests de l'analyse (`node test/analyzer.test.js`) |

`BLUR_THRESHOLD` dans `config.js` règle l'exigence de netteté (70 par défaut ; 50 si l'app dit trop souvent « floue », 90 pour être plus strict).


## Lien généré par le logiciel de compta

Le logiciel de compta (Paramètres du dossier → **Application photo**) génère pour chaque client un lien
`…/scan-factures/?c=CODE&s=ADRESSE_DU_LOGICIEL`, avec un QR code, les consignes pour Android ou iPhone et
une fiche à imprimer. Avec ce lien, l'application envoie les photos au logiciel, qui les range là où le
cabinet l'a choisi : **Google Drive**, **OneDrive** ou **NAS** (WebDAV). Sans paramètre `s`, l'application
continue d'utiliser le serveur Apps Script de `config.js`.

Pour la destination Google Drive, le logiciel passe par ce serveur Apps Script (il écrit dans votre Drive) :
après avoir mis à jour `serveur/Code.gs` (Déployer → Gérer les déploiements → modifier → Nouvelle version),
menu **Factures → Relier au logiciel de compta** donne les deux valeurs à coller sur Render
(`APP_PHOTO_GOOGLE_URL`, `APP_PHOTO_GOOGLE_SECRET`).
