# Levanter Hosting Panel v1

Your own hosting platform for Levanter WhatsApp bots. Users fill in their
WhatsApp session ID + settings on this website, and the panel deploys their
Levanter bot on the same server the panel runs on.

- **Stack:** Node.js + Express only. No database (data in `bots.json`), no build step.
- **Bots:** each bot is a shallow clone of https://github.com/lyfe00011/levanter.git
  in `bots/<name>/`, started with `node index.js` as a detached process.
  Its output goes to `bots/<name>/bot.log`.
- **Capacity:** each bot uses about 270 MB RAM as a rule of thumb. The panel reads the host's real
  memory from `/proc/meminfo` and refuses a new deploy when less than ~300 MB
  would remain free. Note: in testing, Levanter 6.2.3 actually used ~700 MB RSS
  at peak (all plugins loaded), so treat 270 MB as a minimum — the dashboard
  meter always shows the real usage per bot, which is what the panel enforces.

## How to run (on the VPS)

```bash
cd levanter-hosting-panel
npm install
node server.js
# Panel runs on http://<server-ip>:3000
```

First run generates a random admin password and saves it to `.env`
(`ADMIN_PASSWORD=...`). **Open `.env` on the server to see it** — it is never
printed in logs or on any page. Set your own password with:

```bash
ADMIN_PASSWORD='your-strong-password' node server.js
```

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port the panel listens on |
| `BOTS_DIR` | `./bots` | Where bot folders are created |
| `ADMIN_PASSWORD` | *(generated, saved to `.env`)* | Admin login password |

## How a user deploys a bot

1. Log in as admin.
2. Open **+ Deploy bot** and fill in:
   - **Bot name** — lowercase letters, numbers, dashes only (e.g. `my-bot`).
   - **Session ID** — the Levanter WhatsApp session ID. It is a password field
     and is never shown again after saving.
   - **SUDO numbers** — comma-separated phone numbers of the bot owners.
   - **Prefix** — command prefix, default `/`.
   - **Owner number** — optional.
3. The panel clones Levanter, runs `npm install` (a few minutes), writes
   `config.env` (`SESSION_ID`, `SUDO`, `PREFIX`, `VPS=true`) and starts the bot.
4. On the dashboard you can Start / Stop / Restart / Delete a bot and view its
   last 200 log lines. A bot that crashes or disconnects shows as **stopped**.

## Notes and limits

- A bot with a wrong or expired session ID will start and then fail to connect
  to WhatsApp — that is normal. Check its logs; fix the session ID by deleting
  the bot and deploying again with a fresh one.
- `bots.json` contains session IDs. Keep it `0600` (the panel does this) and
  never share it or the `bots/` folder.
- The panel is meant to run on the same VPS as the bots. Put it behind a
  reverse proxy (nginx/Caddy) with HTTPS before exposing it to the internet.
- If the panel restarts, bots keep running (they are detached), but the panel
  will show them as stopped until they are started again from the dashboard.
  Their log files are kept, so nothing is lost.
