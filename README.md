# Burger Bandit Island multiplayer server

This small program lets players of Burger Bandit Island see each other. It runs on Render. There is nothing to install: it uses only what comes with Node.js.

## What it does

- **Rooms:** players make or join rooms with a 4-letter code. A room holds 2 to 32 players (12 by default). A room can be listed for anyone, or code-only.
- **Positions:** about 15 times a second, each player's car or character is passed to the others in the same room. Players more than 700 m away are sent once a second, just for the map. That keeps big rooms light.
- **Chat:** messages go to everyone in the room, with a basic bad-word filter and a limit on how fast anyone can send.
- **Host tools:** the room's host can remove a player. The host's time of day and weather are shared with everyone.
- **Safety:** messages that are too big, broken or flooding are dropped.

## Put it online with Render (one time, about 15 minutes)

1. **GitHub:** make a free account at github.com. Create a new repository called `burger-bandit-island-server` (Private is fine), then upload these files to it: `server.js`, `package.json`, `render.yaml`, `README.md` and the `test` folder.
2. **Render:** make an account at render.com using "Sign in with GitHub".
3. In Render, choose **New → Blueprint**, pick the `burger-bandit-island-server` repository and click **Apply**. The settings come from `render.yaml`: free plan, Oregon region (closest to Vancouver).
4. Wait until the service says **Live**. Open its address, for example `https://burger-bandit-island-server.onrender.com`. You should see "Burger Bandit Island multiplayer server is running."
5. Give that address to Claude. The game connects to it as `wss://burger-bandit-island-server.onrender.com`.

**Free vs paid:** the free plan sleeps after 15 minutes with nobody connected, and the first player then waits about a minute. For an always-on server, open the service in Render, go to **Settings → Instance Type** and pick **Starter**.

## Or put it online with Fly.io (no GitHub needed)

1. Make an account at fly.io and add a card. Fly.io has no free plan; a small server costs a few dollars a month.
2. Install `flyctl`. On Windows, open PowerShell and run:
   `iwr https://fly.io/install.ps1 -useb | iex`
   Then close and reopen PowerShell.
3. Unzip this folder, then in PowerShell go into it, for example `cd Downloads\bbi-server`.
4. Run these, one at a time:
   - `fly auth login` (a browser window opens so you can sign in)
   - `fly launch --copy-config --no-deploy`. If it says the name `burger-bandit-island` is taken, pick another name when asked.
   - `fly deploy`
5. When it finishes, it shows an address like `https://burger-bandit-island.fly.dev`. Give that to Claude; the game connects to it as `wss://burger-bandit-island.fly.dev`.

The settings in `fly.toml` keep one small server always on in Seattle, the closest region to Vancouver.

## Burger Bandit Championship Racing shares this server

The racing game's online lobby runs on this same server, in the `racing` folder. Racing players connect to `wss://<your-server>/racing`; island players keep using the plain address. The two games never see each other's rooms or players.

- **Rooms:** 4-letter codes, public or private, 2 to 12 drivers.
- **Lobby:** the host picks the track, laps and conditions; everyone picks a car and paint and presses Ready; the host starts.
- **Race:** each car's position is passed to the others about 15 times a second. The server keeps the finishing order and sends the results. After the first driver finishes, the rest have 45 seconds.
- `/racing/status` shows racing players and rooms.
- Test it with `node racing/racetest.js` (19 checks, including one that the island game still works).

## Useful addresses

- `/` says the server is running and shows how many players are online
- `/health` answers `ok`, which Render uses to check the server is alive
- `/status` gives players, rooms and uptime as JSON

## Testing locally

```
node server.js          # starts on port 8080
node test/servertest.js # starts its own copy and runs 25 checks with fake players
```
