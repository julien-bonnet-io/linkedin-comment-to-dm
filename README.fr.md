# LinkedIn comment-to-DM bot

[English](README.md) · **Français**

Envoie automatiquement une ressource en DM aux personnes qui commentent sous ton post LinkedIn.
Tourne sur ton ordi, avec ta session LinkedIn, sans API payante. Pilotable seul ou depuis n8n.

Guide complet (contexte, fonctionnement, limites, alternatives) : https://no-mad.io/labo/comment-to-dm

## Ce que ça fait

À chaque passage, pour chaque post de `config.json` :

1. Ouvre le post et charge tous les commentaires
2. Garde ceux qui correspondent au mot-clé (insensible à la casse et aux accents ; plusieurs mots ou modes de correspondance possibles ; mot-clé vide = tous les commentaires), une fois par personne
3. Visite le profil de chaque personne :
   - **déjà en relation** : DM avec la ressource
   - **t'a envoyé une invitation** : l'accepte, puis DM
   - **pas en relation** : invitation sans note. Au passage suivant, si elle a accepté, elle reçoit le DM
   - **invitation en attente** : on repasse plus tard (toutes les 60 min max, pendant 21 jours)
4. Répond sous chaque commentaire traité ("Envoyé en DM 📩", etc.)
5. Note tout dans `leads.csv`

## Installation (une fois)

Prérequis : [Node.js](https://nodejs.org) 18 ou plus, et idéalement Google Chrome installé.

```bash
cd linkedin-comment-to-dm
npm run setup      # installe Playwright + navigateur
npm run login      # ouvre une fenêtre : connecte-toi à LinkedIn, puis Entrée dans le terminal
```

> Windows : si PowerShell refuse `npm` ("l'exécution de scripts est désactivée"), utilise `npm.cmd` à la place.
> Chemin avec des espaces : mets-le entre guillemets, `cd "C:\Users\moi\Desktop\Mon dossier\linkedin-comment-to-dm"`.

La session est gardée dans `.browser-profile/`. Si LinkedIn te déconnecte, relance `npm run login`.

## Configuration : `config.json`

| Champ | Rôle |
|---|---|
| `posts[].url` | URL du post (`···` puis "Copier le lien vers le post") |
| `posts[].keyword` | Mot-clé à détecter, ou liste de mots (`["GUIDE", "intéressé"]`). `""` = tout commentaire déclenche l'envoi |
| `posts[].match` | `contains` (défaut : le mot n'importe où), `word` (mot entier), `exact` (le commentaire ne contient que le mot-clé) |
| `posts[].resourceUrl` | Lien envoyé en DM |
| `posts[].active` | `false` pour arrêter de suivre un post |
| `mySlug` | Ton identifiant `linkedin.com/in/xxx`, pour ignorer tes propres réponses |
| `dryRun` | `true` = simulation, rien n'est envoyé ni mémorisé |
| `replyToComments` | Répondre sous les commentaires |
| `acceptIncomingInvites` | Accepter les invitations des commentateurs |
| `humanReply` | Commentaires qui méritent une vraie réponse : `onQuestion` (contient un « ? »), `minWords` (long commentaire). Le DM part quand même, mais pas de réponse automatique dessous : action `needs_human_reply` dans le rapport |
| `maxProfileVisitsPerRun` | Profils visités max par passage |
| `dailyMaxDMs` / `dailyMaxInvites` | Quotas par jour |
| `activeHours` | Plage horaire d'activité, ex. `[8, 21]` |
| `watchIntervalMinutes` | Délai aléatoire entre deux passages (mode watch) |
| `delayBetweenPeopleSeconds` | Pause aléatoire entre deux personnes |
| `messages.dm` | Texte du DM, ou liste de variantes (une tirée au hasard). Variables : `{firstName}`, `{resourceUrl}` |
| `messages.dmNewConnection` | Facultatif : DM pour les personnes qui viennent d'accepter l'invitation |
| `headless` | `true` = navigateur sans fenêtre (serveur). Défaut `false` |
| `messages.replyDm` / `replyInvite` | Réponses sous le commentaire, une tirée au hasard |

## Option A : en autonomie

```bash
npm run dry     # simulation : visite les profils, affiche ce qui serait fait
npm start       # un passage réel (après "dryRun": false)
npm run watch   # en boucle toutes les 12-20 min (Ctrl+C pour arrêter)
```

## Option B : piloté par n8n

Le bot devient un petit serveur local ; n8n décide quand il passe et envoie les leads où tu veux (CRM, Sheets, Slack…).

```bash
npm run server  # écoute sur http://localhost:3789
```

| Appel | Rôle |
|---|---|
| `GET /health` | `{ ok, busy, lastRun }` |
| `POST /run` | Lance un passage et renvoie le rapport. Body facultatif : `{ "dryRun": true, "posts": [...] }` |
| `GET /leads` | Contenu de `leads.csv` en JSON |

Rapport de `POST /run` (extrait) :

```json
{
  "ok": true,
  "dryRun": false,
  "posts": [{ "post": "7390000000000000000", "comments": 42, "matches": 18, "toProcess": 6 }],
  "events": [
    { "action": "dm_sent", "name": "Jane Doe", "profileUrl": "https://www.linkedin.com/in/jane-doe/", "comment": "Top, GUIDE svp" },
    { "action": "invited", "name": "Bob Martin", "profileUrl": "https://www.linkedin.com/in/bob-martin/", "comment": "guide !" }
  ],
  "counters": { "date": "2026-11-01", "dm": 1, "invite": 1 }
}
```

Actions possibles : `dm_sent`, `already_received`, `invited`, `invite_pending`, `invite_accepted`, `invite_declined`, `dm_failed`, `invite_failed`, `daily_dm_limit`, `daily_invite_limit`, `unknown_relation`, `comment_replied`, `needs_human_reply`, `comment_not_found`, `error`, et en dry run `would_dm`, `would_invite`, `would_accept_and_dm`.

Dans n8n : **Import from File** puis `n8n-workflow.json`. Le plus simple est n8n en local (`npx n8n`), sur le même ordi que le bot.
Avec n8n dans Docker : lance le bot avec `HOST=0.0.0.0` et un `BOT_TOKEN`, et mets `http://host.docker.internal:3789` dans le nœud Config.

```powershell
# Windows PowerShell
$env:HOST="0.0.0.0"; $env:BOT_TOKEN="un-secret-long"; npm run server
```

## Avec Make ou Zapier

Make et Zapier tournent dans le cloud : ils ne peuvent pas joindre `http://localhost:3789`. Deux options :

- **Un VPS** (voir ci-dessous) : le bot y tourne en `npm run server`, exposé derrière un reverse proxy HTTPS.
- **Un tunnel sécurisé** vers votre ordinateur, par exemple Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3789`) : vous obtenez une adresse publique à appeler depuis Make ou Zapier.

Dans les deux cas, **définissez un `BOT_TOKEN`** et envoyez l'en-tête `x-bot-token` à chaque appel. Le scénario reprend le workflow n8n : planification → `GET /health` → `POST /run` → traitement des `events` → CRM.
Les modules de code de Make ou Zapier peuvent porter la logique (filtres, conditions, variantes), pas le navigateur.

## Sur un serveur (VPS), sans ordinateur allumé

Un VPS Linux à 2 vCPU / 4 Go de RAM suffit (quelques euros par mois). Sur Ubuntu :

```bash
# Node.js 20+ installé, puis dans le dossier du bot :
npm install
npx playwright install --with-deps chromium
sudo apt install -y xvfb          # écran virtuel pour Chrome
```

- **Connexion LinkedIn** : faites `npm run login` une fois sur le serveur, via un bureau à distance temporaire (VNC). La session de votre ordinateur ne se copie pas : Chrome la chiffre par machine.
- **Lancement en tâche de fond** : `xvfb-run npm run watch` (ou `xvfb-run npm run server` si n8n pilote), gardé en vie par `pm2` ou `systemd`.
- `"headless": true` dans `config.json` évite xvfb, mais un navigateur sans écran est plus facile à détecter.
- **n8n sur le même serveur** : `HOST=0.0.0.0` + `BOT_TOKEN`, et ne pas ouvrir le port 3789 au public.
- LinkedIn verra une adresse IP de datacenter : attendez-vous à une vérification les premiers jours, gardez des volumes modestes.

## Fichiers générés

- `state.json` : la mémoire (qui a reçu quoi, qui est invité). Supprime-le pour repartir de zéro.
- `leads.csv` : historique (date, nom, profil, statut, commentaire).
- `.browser-profile/` : ta session LinkedIn. **Ne le partage jamais.**

## Garde-fous intégrés

- Un seul DM par personne et par post, même si elle commente plusieurs fois
- Avant d'envoyer, vérifie dans la conversation que le lien n'a pas déjà été envoyé
- Pauses aléatoires, frappe au clavier "humaine", quotas par jour, plage horaire
- S'arrête net si LinkedIn demande une reconnexion ou un checkpoint

## Si quelque chose casse

LinkedIn modifie régulièrement son interface. Tous les sélecteurs sont regroupés dans l'objet `SEL` en haut de `bot.js`.
Si une étape échoue (le log affiche `⚠️`), c'est en général un sélecteur à mettre à jour. Interface LinkedIn en français ou en anglais.

## Risques

Automatiser LinkedIn va contre ses conditions d'utilisation : le risque principal est une restriction temporaire du compte.
Reste sur des volumes modestes (les quotas par défaut sont prudents), ne fais pas tourner plusieurs outils d'automatisation en même temps, et utilise-le à tes risques.

## Licence

MIT, voir [LICENSE](LICENSE). Par [Julien Bonnet](https://no-mad.io).
