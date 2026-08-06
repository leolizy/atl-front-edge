# Packages are deep modules

Every immediate child of `src/` is a **deep module**: a lot of behaviour behind a small interface. A package's public surface is its **entry points — the files at the package root**. Anything in a subfolder is private.

```
src/<name>/
  index.ts        ← an entry point (public). Import this from outside.
  client.ts       ← another entry point. Packages may expose SEVERAL.
  lib/            ← implementation: hidden from outside.
  tests/          ← co-located tests + fixtures (also private).
```

Copy-me: `src/example/` is a starter template — copy it or delete it.

## Rules (enforced by `npm run lint:boundaries`)

1. **Entry-point boundary** — code outside a package may import only that package's root files, never anything in its subfolders.
2. **Intra-package freedom** — a package's own files import each other freely, including their own subfolders.
3. **Tests through the entry points** — files under `<pkg>/tests/` may import any package's entry points and their own `tests/` fixtures, but never any package's subfolder internals.
4. **No cycles** — no dependency cycles.

## Conventions

- **Import only through a package's entry points (its root files).** If you need something that lives in a subfolder, the package chooses to expose it from a root file — that's the package extending its public surface deliberately.
- **No barrel files.** Don't funnel a whole subtree through one giant `index.ts`. Expose several small entry points instead (`index.ts`, `server.ts`, `migrations.ts`, …). Adding an entry point is just adding a root file.
- **Subfolders are private by depth, not by name.** `lib/` and `tests/` are conventions; _any_ subfolder is private, so new folders never need a config change.
- **Packages are flat.** One tier of immediate children under `src/`; a package's internals may nest as deep as needed, but a package may not contain another package.

Run the check:

```sh
npm run lint:boundaries   # depcruise src test — must stay green
```

Config lives in `.dependency-cruiser.cjs`. Layering rules (which packages may depend on which) are a separate concern — there's a commented stub in the config if we ever want them.
