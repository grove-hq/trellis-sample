# Trellis sample

A small Next.js app that shows the [Trellis](https://github.com/grove-hq/trellis) patterns in a real repo.

## Run it

```bash
pnpm install
pnpm dev
```

Then open http://localhost:3000 and sign in as one of the demo users.

The login is a stand-in: it has no password and signs the session cookie with a key that lasts until the server stops. A real app puts its auth provider in `src/lib/session.ts` and `src/app/login/`.

## Patterns

### Authentication

Every request is refused unless it carries a valid session or its path is on a short public list.

- `src/proxy.ts` is the one gate in front of every route. It refuses by default.
- `src/proxy.public-routes.ts` is the public list. Each entry says why it is public.
- `scripts/check-proxy-coverage.ts` runs after the build. It fails if the gate's matcher skips a route the build serves, or if a public entry no longer matches any route.

The first two files are the frame: the part of this pattern a human should own. Nothing in this repo enforces that yet.

### Tenant isolation

Every query carries the caller's organisation, because there is only one way to reach the database.

- `src/db/tenant-db.ts` opens the database and keeps the connection to itself. Other code gets `dbFor(user)`, whose queries are all scoped to that user's organisation.
- `eslint.config.mjs` declares an [import fence](https://github.com/grove-hq/trellis/blob/main/docs/utilities/import-fences.md): only that file may import the database driver, so no other file can open a connection of its own.

Both files are the frame for this pattern.

The database is SQLite in memory, so it resets when the server stops.

## The baseline

A check like the import fence only reads ordinary code. The end of `eslint.config.mjs` holds a short baseline of standard lint rules that close the general ways around such checks, each with a comment saying what removing it reopens.
