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

All three files are in [the frame](#the-frame): the part of this pattern a human owns.

### Tenant isolation

Every query carries the caller's organisation, because there is only one way to reach the database.

- `src/db/tenant-db.ts` opens the database and keeps the connection to itself. Other code gets `dbFor(user)`, whose queries are all scoped to that user's organisation.
- `eslint.config.mjs` declares an [import fence](https://github.com/grove-hq/trellis/blob/main/docs/utilities/import-fences.md): only that file may import the database driver, so no other file can open a connection of its own.

Both files are in [the frame](#the-frame).

The database is SQLite in memory, so it resets when the server stops.

## The frame

The files a pattern depends on are listed in the frame, the marked block in `.github/CODEOWNERS`. A pull request that changes one fails the `Trellis` check until the file's owner signs that exact change:

```bash
node scripts/trellis/ratify.mjs <pr>                # lists the changes and prints a code
node scripts/trellis/ratify.mjs <pr> --sign <code>  # asks for a fingerprint and posts the signature
```

Two files in `.trellis/` cover what a whole-file rule cannot:

- `banned-text.json` bans `eslint-disable` on added lines, since a disable comment switches the import fence off.
- `json-pins.json` pins the `lint` and `check:proxy-coverage` scripts in `package.json`, which are what CI runs.

The check, the signing command and the two workflows are copied from Trellis's [framework](https://github.com/grove-hq/trellis/blob/main/docs/framework.md) into `scripts/trellis/` and `.github/workflows/`. They are in the frame too.

### What makes it binding

The `Trellis` check only blocks a merge because the `main` branch requires it. A branch ruleset on this repo sets:

- Changes reach `main` only through a pull request.
- Two checks must pass first: `Lint and test` and `Trellis`.
- Nobody is on the bypass list, and force pushes and deleting the branch are blocked.

No approving review is required, because this sample has one maintainer. The framework's docs give the [settings](https://github.com/grove-hq/trellis/blob/main/docs/framework.md#making-the-check-binding).

## The baseline

A check like the import fence only reads ordinary code. The end of `eslint.config.mjs` holds a short baseline of standard lint rules that close the general ways around such checks, each with a comment saying what removing it reopens.
