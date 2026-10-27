# Wobble Arena server

A small Node.js server. It does three jobs:

1. **Serves the game page** (the file in `public/`), so players just open your web address.
2. **Keeps the real room list**, so Quick play and Browse rooms always show what is actually open.
3. **Passes messages between the players of a room.** The game itself still runs in the players' browsers: the room's host runs the bots and the rules, and this server is the post office. It does not run the match.

If the game can't find this server it falls back to the old direct (peer-to-peer) connections, so nothing breaks, but you only get the room list and the reliable connections when this server is up.

## Try it on your own computer (2 minutes)

1. Install Node.js 18 or newer from nodejs.org.
2. Open a terminal in this folder and run `npm install` (the `ws` package is already included in `node_modules`, so you can skip this).
3. Run `npm start`.
4. Open `http://localhost:3000` in two browser tabs. In one: Play online → Quick play → pick a mode. In the other: do the same. You should end up in the same game.

The page `public/index.html` is the game. When you get a new version of the game, replace that one file.

## Put it on the internet

Any host that can run a Node.js app and supports WebSockets works. Players need `https` (the host gives you that for free), because browsers only allow secure WebSockets from secure pages.

**Render (easy, has a free plan)**
1. Put this folder in a GitHub repository (the `.gitignore` already leaves out `node_modules`).
2. On render.com: New → Web Service → pick the repository. Render reads `render.yaml`; if it asks, build command is `npm install` and start command is `npm start`.
3. When it finishes you get an address like `https://wobble-arena.onrender.com`. That address *is* your game. Send it to people.
4. Free plans go to sleep when nobody is using them, so the first visit after a quiet period takes up to a minute to wake. A paid plan (a few dollars a month) stays awake.

**Railway, Fly.io, or any VPS:** the included `Dockerfile` works on all of them (`docker build -t wobble . && docker run -p 3000:3000 wobble`). Or just run `npm start` behind a reverse proxy (Caddy and nginx both handle WebSockets).

**Your own domain:** buy one anywhere, then add it as a custom domain in your host's settings. HTTPS is set up automatically.

**Game page on a different site than the server** (for example the game on itch.io and the server on Render): open the game once with `?server=wss://your-server-address/ws` on the end of its web address. It remembers it. Or write the address into `SERVER_URL` near the top of the online code in the game file.

## Accounts

Players sign up in the game with a username, email and password (no email check). The server keeps the account, and a copy of the player's whole save (coins, outfits, controls, settings, stats) so it follows them to any device. Passwords are stored only as salted scrypt hashes. Online play needs an account; guests can press Play and play offline but nothing is saved.

**Where accounts are kept.** Render's free plan wipes the server's own files on every redeploy, so accounts need a small free database:
1. Make a free account at upstash.com, then Create Database (Redis). Pick a region near your server (Singapore if Render is in Singapore). Leave the other settings alone.
2. On the database page, find the **REST API** section and copy **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN**.
3. In Render, open your service, then Environment, and add those two as environment variables. Save. Render redeploys.
4. Open `/health` on your site. It should say `"accounts":"upstash"` and `"saved":true`. If it says `"file"`, the two values are missing or mistyped, and accounts will be lost on the next redeploy.

Without those two values the server still works (accounts go in a file under `./data`), which is fine on your own computer.

## Updating

- New game version: replace `public/index.html` and restart. Each build has a version tag, and the server will not let a player on an old build into a room of a new build ("different version, refresh the page"). That stops half-broken matches after an update.
- The server squashes the game page (brotli or gzip, about 800 KB down to about 215 KB) and remembers it, so friends on slow wifi load it much faster. The page is only re-sent when it changes.
- Check it is alive: open `/health`. It shows how many rooms and players there are.

## Settings

Environment variables: `PORT` (default 3000), `PUBLIC_DIR` (default `./public`), `REQUIRE_LOGIN` (set to `0` to let guests play online; default is that online needs an account), `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (where accounts are kept, see below), `DATA_DIR` (only used when there is no Upstash: where the accounts file goes).
Limits are at the top of `server.js` (`LIMITS`): rooms at once (300), connections at once (3000), connections per address (40), biggest message (32 KB), messages per second per player.

## What it does not do yet (honest list)

- **If the host leaves, the longest-standing player becomes the host** and everyone is moved back to the lobby of the same room. A match that was running is not carried over: the new host starts a fresh one.
- **The host's browser still runs the match**, so a player who edits their own game could cheat. Stopping that needs the match to run on the server. That is a rewrite of the game logic, not a small step.
- **No moderation yet** (no report or ban). Chat has a mute command only. Forgotten passwords: there is no email reset. Instead every account gets a one-time **recovery code** when it is made (shown in the game, stored on the server only as a hash). Typing it on the Forgot password screen sets a new password and gives a fresh code. Players can make a new code in Account > Security. Accounts made before build 70 have no code until they make one. Someone who loses both the password and the code needs a new account. Logins last a year and renew every time the game opens.
- **One server process.** Rooms live in memory, so a restart ends the running games, and you can't run several copies side by side without extra work. One small server is plenty for hundreds of players.
