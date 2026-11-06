# LinkedIn comment-to-DM bot

**English** · [Français](README.fr.md)

Automatically sends a resource by direct message to everyone who comments a keyword under your LinkedIn post, the mechanism behind the "comment GUIDE to get the resource" posts.
It runs on your computer (or a small server) with your own LinkedIn session, no paid API. Use it on its own, or drive it from n8n, Make or Zapier.

Full guide (context, how it works, limits, alternatives): https://no-mad.io/en/lab/comment-to-dm

> Code comments and default messages are in French. Rewrite the messages in `config.json`.

## What it does

On every run, for every post listed in `config.json`:

1. Opens the post and loads all comments
2. Keeps the ones matching the keyword (case and accent insensitive; several keywords and match modes available; empty keyword = every comment), once per person
3. Visits each person's profile:
   - **already connected**: sends the DM with the resource
   - **sent you an invitation**: accepts it, then sends the DM
   - **not connected**: sends an invitation (no note); on a later run, once accepted, they get the DM
   - **invitation pending**: checks again later (at most every 60 min, for 21 days)
4. Replies under each handled comment ("Sent by DM 📩"…), except real questions, left to a human
5. Logs everything in `leads.csv`

## Install (once)

Requirements: [Node.js](https://nodejs.org) 18+, ideally Google Chrome.

```bash
cd linkedin-comment-to-dm
npm run setup      # installs Playwright + browser
npm run login      # opens a window: log in to LinkedIn, then press Enter in the terminal
```

> Windows: if PowerShell blocks `npm` ("running scripts is disabled"), use `npm.cmd` instead.
> Paths with spaces: wrap them in quotes, `cd "C:\Users\me\Desktop\My folder\linkedin-comment-to-dm"`.

The session is stored in `.browser-profile/`. If LinkedIn logs you out, run `npm run login` again.

## Configuration: `config.json`

| Key | Purpose |
|---|---|
| `posts[].url` | Post URL (`···` then "Copy link to post") |
| `posts[].keyword` | Keyword, or list of keywords (`["GUIDE", "interested"]`). `""` = every comment triggers a send |
| `posts[].match` | `contains` (default: keyword anywhere), `word` (whole word), `exact` (the comment is just the keyword) |
| `posts[].resourceUrl` | Link sent by DM |
| `posts[].active` | `false` to stop tracking a post |
| `mySlug` | Your `linkedin.com/in/xxx` handle, so your own replies are ignored |
| `dryRun` | `true` = simulation, nothing is sent or remembered |
| `replyToComments` | Reply under comments |
| `acceptIncomingInvites` | Accept invitations from commenters |
| `humanReply` | Comments that deserve a real answer: `onQuestion` (contains "?"), `minWords` (long comment). The DM still goes out, but no automatic public reply (`needs_human_reply` in the report) |
| `maxProfileVisitsPerRun` | Max profiles visited per run |
| `dailyMaxDMs` / `dailyMaxInvites` | Daily quotas |
| `activeHours` | Active hours, e.g. `[8, 21]` |
| `watchIntervalMinutes` | Random delay between runs (watch mode) |
| `delayBetweenPeopleSeconds` | Random pause between two people |
| `headless` | `true` = no browser window (servers). Default `false` |
| `messages.dm` | DM text, or list of variants (one picked at random). Variables: `{firstName}`, `{resourceUrl}` |
| `messages.dmNewConnection` | Optional: DM for people who just accepted the invitation |
| `messages.replyDm` / `replyInvite` | Public replies under the comment, one picked at random |

## Option A: standalone

```bash
npm run dry     # simulation: visits profiles, shows what would happen
npm start       # one real run (after "dryRun": false)
npm run watch   # loops every 12-20 min (Ctrl+C to stop)
```

## Option B: driven by n8n, Make or Zapier

The bot becomes a small local server; the orchestrator decides when it runs and sends the leads wherever you want.

```bash
npm run server  # listens on http://localhost:3789
```

| Call | Purpose |
|---|---|
| `GET /health` | `{ ok, busy, lastRun }` |
| `POST /run` | Starts a run and returns the report. Optional body: `{ "dryRun": true, "posts": [...] }` |
| `GET /leads` | `leads.csv` as JSON |

Report returned by `POST /run` (excerpt):

```json
{
  "ok": true,
  "dryRun": false,
  "posts": [{ "post": "7390000000000000000", "comments": 42, "matches": 18, "toProcess": 6 }],
  "events": [
    { "action": "dm_sent", "name": "Jane Doe", "profileUrl": "https://www.linkedin.com/in/jane-doe/", "comment": "Great, GUIDE please" },
    { "action": "invited", "name": "Bob Martin", "profileUrl": "https://www.linkedin.com/in/bob-martin/", "comment": "guide!" }
  ],
  "counters": { "date": "2026-11-01", "dm": 1, "invite": 1 }
}
```

Possible actions: `dm_sent`, `already_received`, `invited`, `invite_pending`, `invite_accepted`, `invite_declined`, `dm_failed`, `invite_failed`, `daily_dm_limit`, `daily_invite_limit`, `unknown_relation`, `comment_replied`, `needs_human_reply`, `comment_not_found`, `error`, and in dry run `would_dm`, `would_invite`, `would_accept_and_dm`.

**n8n**: import `n8n-workflow.json` (Workflows > Import from File). Simplest setup: n8n on the same machine (`npx n8n`).
With n8n in Docker: start the bot with `HOST=0.0.0.0` and a `BOT_TOKEN`, and use `http://host.docker.internal:3789` in the Config node.

**Make or Zapier** run in the cloud and can't reach `localhost`. Either run the bot on a server (below), or expose it through a secure tunnel such as Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3789`). In both cases set a `BOT_TOKEN` and send it in the `x-bot-token` header. Their code steps can hold the logic (filters, conditions, variants), not the browser.

```powershell
# Windows PowerShell
$env:HOST="0.0.0.0"; $env:BOT_TOKEN="a-long-secret"; npm run server
```

## On a server (VPS), computer off

A Linux VPS with 2 vCPU / 4 GB RAM is enough (a few euros a month). On Ubuntu:

```bash
# Node.js 20+ installed, then in the bot folder:
npm install
npx playwright install --with-deps chromium
sudo apt install -y xvfb          # virtual screen for Chrome
```

- **LinkedIn login**: run `npm run login` once on the server, through a temporary remote desktop (VNC). Your computer's session can't be copied: Chrome encrypts it per machine.
- **Background run**: `xvfb-run npm run watch` (or `xvfb-run npm run server` if an orchestrator drives it), kept alive by `pm2` or `systemd`.
- `"headless": true` avoids xvfb, but a windowless browser is easier to detect.
- LinkedIn will see a datacenter IP address: expect a security check in the first days, keep volumes modest.

## Generated files

- `state.json`: memory (who got what, who was invited). Delete it to start over.
- `leads.csv`: history (date, name, profile, status, comment).
- `.browser-profile/`: your LinkedIn session. **Never share it.** (All three are in `.gitignore`.)

## Built-in safeguards

- One DM per person and per post, even if they comment several times
- Checks the conversation before sending, so a link is never sent twice
- Random pauses, human-paced typing, daily quotas, active hours
- Stops immediately if LinkedIn asks to log in again or shows a checkpoint

## When something breaks

LinkedIn changes its interface regularly. All selectors are grouped in the `SEL` object at the top of `bot.js`: when a step fails (the log shows `⚠️`), it is usually a selector to update. Works with LinkedIn in French or English.

## Risks

LinkedIn's terms of use forbid automation: the main risk is a temporary account restriction. Keep volumes modest (default quotas are conservative), don't run several automation tools at once, and use it at your own risk.

## License

MIT, see [LICENSE](LICENSE). By [Julien Bonnet](https://no-mad.io).
