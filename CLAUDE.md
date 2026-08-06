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

# AI features are credit-metered

**Before implementing any feature that calls an LLM, determine its credit cost
and add it to the table below.** Treat the table as the single source of truth:
if a feature you are about to build is not listed, decide its cost and record it
here _first_, in proportion to its expected token spend relative to the existing
entries.

Every metered route must:

1. Check the caller's balance **before** dispatching any model call — a caller
   with insufficient credits gets `402` and the provider is never contacted.
2. Reserve on request and refund on failure, so a crashed call never silently
   bills.
3. Write to the append-only `credit_ledger`. The balance on `users` is a derived
   cache and is never authoritatively overwritten.

## Cost table

| Feature                               | Credits |
| ------------------------------------- | ------- |
| Triage one document                   | 1       |
| Extract from one document             | 5       |
| Copilot question (≤ 2 tool calls)     | 3       |
| Copilot question (path-finding / > 2) | 5       |
| Weekly briefing                       | 15      |
| Re-extraction retry                   | 5       |

## Features that cost 0 and must NOT deduct credits

Anything that does not call an LLM: viewing the graph, filtering, focus mode,
approving or rejecting proposals, and **all graph analytics** (betweenness,
eigenvector, community detection, path-finding). These are deterministic
algorithms, not model calls.

This is a deliberate product decision — a user with no credits must still get the
full visualisation and every structural insight. Only generation and extraction
stop. Do not paywall analytics.

Full design: [`docs/superpowers/specs/2026-08-06-ai-integration-design.md`](docs/superpowers/specs/2026-08-06-ai-integration-design.md)
