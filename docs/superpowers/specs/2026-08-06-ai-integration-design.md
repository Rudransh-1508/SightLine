# Sightline — AI Integration Design

**Date:** 2026-08-06
**Status:** Approved design, not yet implemented
**Branch:** all work happens on a feature branch; `main` stays the public assignment baseline

---

## 1. Goal

Turn Sightline from a static visualisation of hand-authored data into a living
stakeholder intelligence tool: a graph that grows from real sources under human
review, enriched with structural analytics, and queryable in natural language.

Two objectives held together:

- **Product value** — what a risk analyst would actually use.
- **Technical depth** — real extraction, entity resolution, grounded retrieval,
  and a measurable quality bar.

**Explicit non-goal:** a GNN. At 35 nodes (and likely a few hundred after early
ingestion) link prediction would overfit and prove nothing. The interesting
version — predicting which relationships will deteriorate — needs temporal
history the pipeline has not yet produced. Classical graph analytics deliver most
of the value immediately with no training data. GNNs are revisited only once the
ingested dataset has real scale and months of revision history.

**Fallback:** if extraction quality proves unworkable, fall back to a synthetic
scale-up of the graph. The copilot layer is unaffected by where nodes came from,
so it survives that pivot unchanged.

---

## 2. Scope

In scope:

1. **Ingestion pipeline** — real sources to staged, evidenced change proposals.
2. **Analyst review queue** — human approval before anything enters the graph.
3. **Classical graph analytics** — betweenness, eigenvector, communities, paths.
4. **Grounded copilot** — tool-use over the graph, steering the visualisation.
5. **Auth (WorkOS)** and **credit metering** for all AI features.
6. **Eval harness** — extraction precision/recall, run manually.

Out of scope: GNN/embedding models, autonomous agents that write unsupervised,
multi-tenant billing beyond a credit balance.

---

## 3. Architecture

### 3.1 Core invariant

> **The trusted graph is only ever mutated through an approved proposal.**

Nothing writes to `nodes` or `edges` directly — not the pipeline, not a script.
This single rule yields provenance, audit history and rollback as a consequence
rather than as extra features, and it is what makes the review queue meaningful.

### 3.2 Two datasets, one schema, one codebase

Keeping the illustrative demo and the sourced data in separate _datasets_ — not
separate applications — avoids maintaining two of everything.

| slug          | kind           | contents                                             |
| ------------- | -------------- | ---------------------------------------------------- |
| `repsol-demo` | `illustrative` | the 35 curated nodes, seeded by migration, immutable |
| `live`        | `sourced`      | starts empty, fills only via approved proposals      |

Tightened invariant, enforced by a database constraint rather than by
discipline:

> **A proposal may only target a dataset where `kind = 'sourced'`.**

The demo dataset therefore _cannot_ be corrupted by the pipeline. The
provenance banner becomes a property of the dataset: `illustrative` renders the
existing amber "invented data" warning; `sourced` renders per-edge source
citations. Same components throughout, with a dataset switcher in the header.

### 3.3 Schema

```
datasets      id, slug, name, kind ('illustrative' | 'sourced'), description

nodes         id, dataset_id, name, category, country, region, influence,
              role, description, key_people
edges         id, dataset_id, source_id, target_id, type, direction, strength,
              state, trajectory, exposure, since, narrative, confidence
              -- field semantics unchanged from src/lib/types.ts

sources       id, url, title, publisher, published_at, fetched_at, content_hash
              -- dedupe on content_hash, not URL: one story, many URLs

proposals     id, dataset_id, kind ('node_create'|'edge_create'|'edge_update'),
              target_ref, payload jsonb, evidence_quote, source_id, confidence,
              model, status ('pending'|'approved'|'rejected'|'auto_rejected'),
              created_at, reviewed_at, reviewer_note

revisions     id, entity_type, entity_id, field, old_value, new_value,
              proposal_id, applied_at

node_metrics  node_id, betweenness, degree, eigenvector, community_id,
              computed_at

users         workos_user_id, email, credit_balance
credit_ledger id, user_id, delta, feature, ref_id, reason, created_at
              -- append-only; balance is derived, never overwritten
```

`revisions` upgrades the existing static `lastEvent` field into a real history:
every relationship gains a timeline of what changed, when, and on what evidence.

### 3.4 Stack additions

| Concern   | Choice                       | Reason                                                   |
| --------- | ---------------------------- | -------------------------------------------------------- |
| Database  | Neon Postgres                | serverless, good Vercel story, generous free tier        |
| ORM       | Drizzle                      | TypeScript-native, light, serverless-friendly migrations |
| LLM       | OpenRouter via `openai` SDK  | model-agnostic; swapping models is a config string       |
| Analytics | graphology                   | mature, well-tested; no reason to hand-roll betweenness  |
| Auth      | `@workos-inc/authkit-nextjs` | chosen by the project owner                              |

**On OpenRouter:** base URL `https://openrouter.ai/api/v1`, `OPENROUTER_API_KEY`,
model as an env-configurable string. Being model-agnostic is a genuine advantage
for the eval harness: extraction precision can be compared across several models
cheaply, and that comparison is itself a reportable result. Model choice for
extraction is constrained by strict JSON-schema structured output and tool-calling
support; confirm current support before selecting.

### 3.5 Routes and access

Everything is behind auth. The public baseline lives on `main`, not here.

| Route                        | Access                    |
| ---------------------------- | ------------------------- |
| `/`                          | authenticated             |
| `/review`                    | authenticated             |
| `/api/graph`                 | authenticated             |
| `/api/chat`                  | authenticated + credits   |
| `/api/ingest`                | authenticated + credits   |
| `/api/proposals/:id/approve` | authenticated (0 credits) |
| `scripts/ingest.ts`          | CLI, service credentials  |

**Assignment safety:** `main` continues to serve the current public, static
Repsol visualisation at the existing Vercel URL — that remains the submission.
This design is developed on a branch. After the AI work is complete, the two are
merged into a single gated application and the submission write-up carries demo
credentials for reviewers.

**Credentials handling:** `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
`WORKOS_COOKIE_PASSWORD` and `OPENROUTER_API_KEY` go into `.env.local`, added by
the project owner directly. Secrets are never pasted into agent conversations.

---

## 4. The ingestion pipeline

Seven stages, each independently testable:

```
1. FETCH     RSS / news API -> raw document
             dedupe on content_hash

2. TRIAGE    cheap model: "does this mention any tracked entity?"
             kills the large majority of volume before expensive calls

3. EXTRACT   structured output against a JSON schema mirroring the
             unions in types.ts -> proposed entities, relationships,
             state/trajectory changes, evidence_quote, confidence

4. RESOLVE   map extracted names -> existing node IDs
             alias table + fuzzy match; unresolved -> propose new node

5. STAGE     write to proposals (never to nodes/edges)

6. REVIEW    human approves -> apply in a transaction -> write revisions

7. METRICS   recompute betweenness / communities for the changed dataset
```

**Stage 2 is the cost control.** Triaging with a cheap model before extracting
with an expensive one is the difference between a pipeline that can be run daily
and one that cannot.

**Stage 4 is the hard part.** "Sonatrach", "Sonatrach SPA", "the Algerian state
oil company" and "SH" are one node; "Repsol" and "Repsol Sinopec" are not. Get
this wrong and duplicate entities accumulate until the graph is worthless. An
alias table plus fuzzy matching handles the common cases; embeddings are a later
option if precision proves insufficient.

### 4.1 Failure modes designed for

| Failure                     | Handling                                                                  |
| --------------------------- | ------------------------------------------------------------------------- |
| Malformed model output      | schema validation at the boundary; reject and log, batch survives         |
| Hallucinated evidence       | `evidence_quote` absent from source text -> `auto_rejected` before review |
| Contradictory proposals     | surfaced as a conflict, shown side by side; never silent last-write-wins  |
| Rate limits / partial batch | per-document checkpointing; a rerun resumes rather than restarts          |
| Runaway spend               | hard credit ceiling per run — abort, not warn                             |

The evidence check deserves emphasis: it is a cheap, deterministic, non-LLM
guard against the most dangerous failure mode — a fabricated quote attached to a
real source URL.

---

## 5. Analytics

Computed per dataset on write, cached in `node_metrics`. **Deterministic graph
algorithms, not model calls — always free.**

| Metric              | Answers                                                   |
| ------------------- | --------------------------------------------------------- |
| Betweenness         | chokepoints — the actors exposure routes _through_        |
| Eigenvector         | influence weighted by whom you are connected to           |
| Community (Louvain) | clusters the data finds itself, vs. hand-assigned regions |
| Shortest paths      | "how does OFAC actually reach Repsol?"                    |

Two payoffs:

1. **The existing visualisation gets smarter.** Toggles to size nodes by computed
   betweenness rather than hand-assigned `influence`, and to colour by discovered
   community rather than assigned region. Disagreement between the two is itself a
   finding — if Louvain splits the "Iberia" cluster, the regional model is hiding
   something.
2. **They become copilot tools**, letting the model answer structural questions
   rather than recalling text.

---

## 6. The copilot

### 6.1 Tool-use over the graph, not vector RAG

The instinct is to embed narratives and do similarity search. This design
deliberately does not. Vector search cannot answer _"how does OFAC reach
Repsol?"_ — that is a traversal, not a similarity lookup. The graph is already a
precise structured index; the model queries it directly.

Tools exposed:

```
searchEntities(query)         getRelationships(nodeId, filters)
getNode(id)                   findPaths(fromId, toId, maxHops)
getMetrics(nodeId)            filterEdges({state, trajectory, minStrength})
getTimeline(edgeId)           -> revisions history for that relationship
```

**Grounding rule:** the model may only assert what tools returned, and every
claim carries the node/edge IDs it came from. This is enforceable and testable,
which matters because a confidently wrong geopolitical claim is the failure mode
that would genuinely discredit the tool.

### 6.2 Graph-steering chat

Because answers cite entity IDs, chat and graph drive each other. Asking
_"what's my Algeria exposure?"_ streams an answer while the graph focuses
`Repsol -> Sonatrach -> Algeria` and dims the rest, reusing the existing focus
mode. Clicking a citation opens that edge in the sidebar.

This is the interaction worth building: a natural-language question that _steers
the visualisation_, with every sentence traceable to a clickable edge. It makes
grounding visible rather than something taken on trust.

If scope must be cut later, plain cited-text answers still work; the graph sync is
the piece to drop.

### 6.3 Briefings

Same tools, fixed prompt, run over `revisions` since the last run: _"Since last
week, three relationships moved; the most material is X, because Y."_ No new
machinery — the copilot pointed at a time window.

---

## 7. Auth and credit metering

### 7.1 Credits

**Reserve then settle.** Credits are deducted on request and refunded on failure,
so a crashed call never silently bills. Balance is checked at route entry;
insufficient credits returns `402` **before any LLM call is dispatched**.

`credit_ledger` is append-only. The balance on `users` is a derived cache, never
authoritatively overwritten.

### 7.2 Cost table

Costs track expected token spend; the cheapest unit is 1.

| Feature                               | Credits |
| ------------------------------------- | ------- |
| Triage one document                   | 1       |
| Extract from one document             | 5       |
| Copilot question (<= 2 tool calls)    | 3       |
| Copilot question (path-finding / > 2) | 5       |
| Weekly briefing                       | 15      |
| Re-extraction retry                   | 5       |

**Zero credits — not AI features:** viewing the graph, filtering, focus mode,
approving or rejecting proposals, and _all_ analytics (betweenness, communities,
path-finding). These are deterministic algorithms, not model calls.

A user with no credits still gets the complete visualisation and every structural
insight. Only generation and extraction stop. This is a deliberate product
decision: the graph's analytical value must not be paywalled behind token spend.

---

## 8. Testing

**Hard requirement: the test suite must never cost money.** No network calls to
any model provider, in any test, ever.

The LLM client is an injected interface:

```
lib/llm/client.ts      interface LlmClient { complete(), stream(), tools() }
lib/llm/openrouter.ts  real implementation
lib/llm/mock.ts        canned structured responses
```

Route-level tests cover the failure classes that matter:

| Test                              | Asserts                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `POST /api/chat`                  | citations reference real node IDs; tool args well-formed   |
| `POST /api/ingest`                | proposals land in staging; `nodes`/`edges` untouched       |
| `POST /api/proposals/:id/approve` | transaction applies edge _and_ writes `revisions`          |
| approve targeting `repsol-demo`   | rejected by the **database constraint**, not the app layer |
| evidence-quote mismatch           | `auto_rejected` (pure string check, no model involved)     |
| insufficient credits              | `402` **and the LLM mock is never invoked**                |

The existing 84 tests are unchanged. The demo dataset is seeded from
`src/data/stakeholders.json` via migration, so the data-integrity suite continues
to guard the same file — it simply also becomes the seed fixture.

CI gains a Postgres service container for the database-backed tests.

**The eval harness is not a test.** It inherently costs money, so it is a
standalone `pnpm run eval` invoked deliberately: ~50 hand-labelled articles
measuring extraction precision/recall per model. Never in CI, never gating a
push. It remains the project's headline quality artefact — turning "we used AI"
into "extraction runs at _n_ precision on a held-out set."

---

## 9. Build order

1. Database, Drizzle schema, migrations, seed `repsol-demo` from existing JSON
2. WorkOS auth; move `/` to DB-backed rendering
3. Credit ledger and metering middleware (before any LLM code exists)
4. Analytics + UI toggles — immediate value, no model calls
5. Ingestion: fetch, triage, extract, resolve, stage
6. Review queue UI
7. Copilot tools and `/api/chat`
8. Graph-steering chat sync
9. Eval harness
10. Briefings

Credit metering lands at step 3, before the first model call, so no feature can
ever be built that bypasses it.

---

## 10. Open questions

- Which news sources/APIs — free tiers may constrain volume and licensing.
- Which OpenRouter models for triage vs. extraction; settle via the eval harness.
- Where credits come from initially (manual grant vs. signup allowance).
