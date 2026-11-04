# HSH SovereignSoul Admin

Small standalone admin app. It does not modify the supplied game API. Express serves the page and uses the Supabase service role key on the server only; never put that key in HTML, launcher code, or a public repository.

## Run locally

1. Create a Supabase project and run `schema.sql` in its SQL Editor.
2. Copy `.env.example` to `.env`; fill `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and a long random `ADMIN_TOKEN`.
3. Run `npm install` and `npm start`, then open `http://localhost:3000`.

## Deploy on Render

Create a **Web Service** from this folder/repository. Runtime: Node. Build command: `npm install`; Start command: `npm start`. Add the four environment variables from `.env.example` in Render settings. Do not commit `.env`.

## Launcher read endpoints

- `GET https://YOUR-SERVICE.onrender.com/public/whitelist` returns approved players as JSON.
- `GET https://YOUR-SERVICE.onrender.com/public/servers` returns online server rows.
- The admin's Kill All button inserts `kill_all_launchers` into `launcher_commands`. A trusted launcher agent can poll `GET /launcher/commands` using `Authorization: Bearer LAUNCHER_TOKEN`, then acknowledge with `POST /launcher/commands/:id/ack` and JSON `{"status":"received"}`. Polling is used here so the Supabase service key stays private.

The public endpoints are read-only. A launcher integration still needs to implement its own polling loop and handle the command by closing its process; a website cannot remotely close installed programs by itself. Protect `/public/whitelist` with a token or network policy if the player list should not be public.

## Cluster Explorer and existing player data

The Cluster Explorer opens in its own main view when a database is selected; it does not appear alongside the Whitelist. The left sidebar has a separate Whitelist entry. The explorer seeds `HSHO-PrivateServer` and collections `players`, `whitelists`, and `serverinfo`. Whitelist edits update the same SQL table. Server room edits in the `serverinfo` collection update the same SQL table. The `players` collection accepts the existing game's flexible player document shape. Export the MongoDB `players` collection as JSON, select `players`, and choose **นำเข้า JSON**. Then choose **⇄ เพิ่มผู้เล่นเข้า Whitelist** to copy player fields into new Whitelist columns; existing approval status and notes are preserved.

The Whitelist stores all fields from the supplied game Player model, including `auth` and `session_token`. Those fields are visible only through the authenticated admin API; `/public/whitelist` returns only the public identifiers and approval status. Keep the service role key and admin token private. The source `DATA.zip` contains player templates/static data rather than live MongoDB player records, so actual players must be exported from MongoDB and imported. The current game API remains MongoDB-backed until separately migrated. Core database and collections are protected from deletion; custom namespaces and their documents can be deleted from the explorer.

The admin token is entered in the page and held only in that browser tab's session storage. The server has a simple shared-token gate; place the service behind HTTPS and rotate the token if exposed.
