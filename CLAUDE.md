<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Before considering any change done

Run `pnpm run verify` (format check → lint → typecheck → test → build — the
same steps and order as `.github/workflows/ci.yml`) and make sure it passes
before ending your turn. If something fails, fix it before reporting the work
as complete — do not leave a broken `verify` for the next push to surface in
CI. If you only touched one layer (e.g. just docs), running the equivalent
individual script (`pnpm run format`, `pnpm run lint`, etc.) is enough, but
when in doubt run the full `verify`.
