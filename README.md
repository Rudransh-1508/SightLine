# Sightline

**An interactive force-directed map of the actors around a company — who they are, how much of the company's position rides on each one, what state each relationship is in, and where it is heading.**

Built for ApexSignal's stakeholder relationship visualiser assignment. Named for what it does: a stakeholder network is normally an undifferentiated tangle, and the job of this tool is to give you a clear line of sight through it to a single relationship.

<!-- Once pushed, add the CI badge:
     ![CI](https://github.com/<owner>/sightline/actions/workflows/ci.yml/badge.svg) -->

**Client chosen:** Repsol. Of the suggested companies it has the most legible geopolitical texture — a single dominant gas supply channel routed through a state-owned counterparty (Sonatrach/Algeria), a sanctioned-jurisdiction position whose value is set in Washington rather than Caracas, a contested-authority producing environment (Libya), and a domestic transition fight conducted in front of regulators. That gives the graph real structure to show instead of a uniform spray of "partners".

> **Illustrative data.** Organisation and individual names are real, and used so the model reads realistically. Every relationship state, score, exposure figure, event and narrative in `src/data/stakeholders.json` is **invented** for this assignment. Nothing in this repo is reporting, or a factual claim about any real entity or person. A dismissible banner says the same thing in the app.

---

## 1. The data model

The whole tool rests on one decision: **what an edge carries.** A graph of "Repsol — connected to — Sonatrach" is a diagram. A graph that says _how_ that connection is doing and _which way it is moving_ is an analytical instrument. The schema lives in [`src/lib/types.ts`](src/lib/types.ts).

### Node

| Field                 | Purpose                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `id`, `name`          | identity                                                                                                                 |
| `category`            | one of 10 actor types (government, regulator, supplier, competitor, customer, financier, union, ngo, individual, client) |
| `country`, `region`   | `region` seeds spatial clustering in the layout                                                                          |
| `influence` (0–100)   | material influence over Repsol's position → drives node **size**                                                         |
| `role`, `description` | one-line and paragraph read for the sidebar                                                                              |
| `keyPeople`           | named individuals inside an institution                                                                                  |

### Edge — the part that matters

| Field                | Purpose                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `type`               | contractual / regulatory / equity / financing / adversarial / political / advocacy / labour |
| `direction`          | `mutual`, `source-depends`, `target-depends`                                                |
| `strength` (0–100)   | how much of Repsol's position rides on it → drives link **width**                           |
| **`state`**          | hostile / strained / transactional / stable / cooperative → drives link **colour**          |
| **`trajectory`**     | deteriorating / stable / improving                                                          |
| `exposure`           | what is concretely at stake, in words                                                       |
| `since`, `lastEvent` | when it began; the most recent movement, dated                                              |
| `narrative`          | 2–3 sentences of analyst read                                                               |
| `confidence`         | high / medium / low                                                                         |

### Four decisions worth defending

**`state` and `trajectory` are separate axes, not one health score.**
This is the core of the model. A relationship can be _hostile but stable_ (Greenpeace — nothing will change, and that's fine), _strained but improving_ (Sonatrach — the repricing cycle looks to have peaked), or _stable but deteriorating_ (the Spanish state — still workable, but fiscal pressure is eroding the terms). Collapsing these into a single 1–5 "health" number destroys exactly the signal the brief asks for. The header strip therefore reports them separately: a state distribution _and_ a count of what is moving which way.

**`direction` encodes leverage, not topology.**
An edge already has two endpoints; storing an arrow adds nothing. What is worth storing is _who needs whom_. Repsol depends on Sonatrach for gas. The CNMC does not depend on Repsol at all. The OFAC edge is the extreme case — total consequence, zero leverage — and the model can say so.

**Multiple edges between the same pair are allowed.**
Repsol and TotalEnergies hold **two** relationships: `equity` (cooperative, shared North African consortium exposure) and `adversarial` (transactional and hardening, competing for the same EU transition funding). Averaging those into one edge would erase both. The renderer curves parallel edges apart so both stay visible.

**Inter-stakeholder edges, not a star.**
19 of the 54 edges do not touch Repsol, and they carry much of the analytical value. `Algeria → Sonatrach` is why the supply contract can't be read as commercial. `OFAC → PDVSA` is why the Venezuelan JV is governed from Washington. `ClientEarth → European Commission` is the transmission mechanism that turns NGO pressure into binding regulation — it links two separate adverse edges into one reinforcing problem. Without these the force layout would be meaningless: a star has no structure to relax into.

**Dataset:** 35 nodes, 54 edges, no orphans, no dangling references.

---

## 2. Two deliberate deviations from the brief

The brief asks for _"node colouring based on relationship type."_ I did something different, and think it's the right call:

**Relationship state colours the _edge_, not the node.** State is a property of a relationship, and a node has many relationships — Repsol is cooperative with MITECO and hostile to ClientEarth simultaneously. Colouring the node by its relationship would force an arbitrary "primary relationship" and would say nothing at all about the 19 edges that don't touch Repsol. So: **node = what the actor is (shape + colour), edge = how the relationship is doing (colour + dash).** The intent of the requirement — colour encodes relationship — is met, on the mark that actually owns the property.

**Category is carried by shape first, colour second.** See §4 — this one was forced by measurement, not preference.

---

## 3. Legibility

The brief warns that forty nodes turns into a hairball. Everything below exists to fight that.

- **The client is pinned at centre** (`fx`/`fy`). The subject of the analysis never wanders, so the reader keeps their bearings across every interaction.
- **Geographic clustering.** `forceX`/`forceY` pull each node toward an anchor for its region (Iberia, North Africa, Latin America, Europe, North America) at strength 0.16 — enough to hold the regions visually apart, weak enough that topology still shows through. Without it the layout collapses into one undifferentiated ball.
- **Proximity encodes exposure.** Link distance is inversely proportional to `strength`, so the relationships Repsol is most exposed to physically sit closest.
- **Focus mode.** Hovering or selecting any node drops everything more than one hop away to 8% opacity. Selecting Sonatrach reduces 35 nodes to 4 — Repsol, Algeria, Naturgy and itself — which is the entire Algerian gas problem, isolated, without losing the surrounding structure.
- **Zoom-tiered labels.** Only the client and high-influence actors are named when zoomed out; everything is named when zoomed in; a hovered or selected node always shows its label. This is driven by a `data-zoom` attribute set by the d3 zoom handler and resolved in CSS, so **React never re-renders while the reader is zooming**.
- **Filters that subtract.** Actor type, relationship state, trajectory, a minimum-tie-strength slider, and free-text search. Filtered-out nodes are dimmed _in place_ rather than removed from the simulation — the layout never reflows, so the reader never loses the mental map they just built.
- **A "risk lens" preset.** One click sets trajectory = deteriorating and strength ≥ 45, isolating the 13 material relationships that are getting worse. This is the view the tool exists to produce.
- **Curved parallel edges**, so dual relationships never hide behind one another.
- **Fit-to-bounds framing.** The view is framed by measuring the actual laid-out node extent, not a guessed zoom level — because the extent depends on how the simulation happened to settle.

---

## 4. Colour and accessibility

This part was validated rather than eyeballed, using a palette validator that measures colour-vision-deficient separation in OKLab.

**The first attempt failed.** Ten actor categories mapped onto a categorical palette looked fine to me and was quantitatively broken: magenta↔aqua measured **ΔE 1.6 under deuteranopia** (target ≥ 8) and red↔orange measured **ΔE 7.1 for normal vision** (floor 15). In a network graph any two nodes can end up adjacent, so the lenient "adjacent pairs only" standard doesn't apply — every pair has to hold.

**The fix was to stop making colour do all the work.** Categories are split into shape families, and colour only has to separate categories _within_ a family:

| Shape      | Categories                     | All-pairs CVD result |
| ---------- | ------------------------------ | -------------------- |
| ■ square   | government, regulator          | ΔE 26.8 ✅           |
| ● circle   | supplier, competitor, customer | ΔE 8.4 ✅            |
| ⬢ hexagon  | financier                      | single ✅            |
| ▲ triangle | ngo, union                     | ΔE 13.0 ✅           |
| ◆ diamond  | individual                     | single ✅            |
| ○ ring     | client (Repsol)                | single ✅            |

Every family passes all-pairs CVD and normal-vision floors on the dark surface. The pairs that still fail in isolation are never the same shape, so shape resolves them.

**Relationship state is a diverging scale** — a red arm (hostile, strained), a neutral grey midpoint (transactional), a blue arm (stable, cooperative). Red↔blue rather than the intuitive red↔green, because red/green is precisely the pair CVD readers cannot separate. The adverse arm is **additionally dashed**, so polarity never rests on hue alone. Trajectory is carried by a glyph (▲ ■ ▼) and by text, never by colour alone.

Also: `prefers-reduced-motion` is respected, node groups carry `aria-label`s, and Escape clears the selection.

---

## 5. Technical approach

**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind 4 · d3-force / d3-zoom / d3-drag / d3-selection. Data is a static JSON file; the page prerenders as static content and needs no backend.

**The React/D3 split** is the main architectural decision. Both want to own the DOM, so the boundary is drawn explicitly:

- **d3 owns the simulation maths** and writes node/link positions **straight to the DOM** on every tick via refs. Re-rendering ~90 elements through React at 60fps would be wasteful and would jank.
- **React owns element structure** and every encoding that changes at human speed — selection, hover, filtering, focus dimming.
- **They never write the same attributes.** d3 touches `transform` and `d`; React touches `opacity`, `stroke`, `stroke-width`, `pointer-events`.

Simulation data is deep-copied from the imported JSON, since `forceLink` mutates edges in place (replacing string ids with node references) and `forceSimulation` writes `x`/`y`/`vx`/`vy` onto nodes.

**Layout:** `src/lib/` holds the domain (types, palette, graph helpers); `src/components/` holds `GraphCanvas`, `DetailPanel`, `Controls`. Filtering is computed once in `page.tsx` and pushed down as two visibility `Set`s, so the canvas stays a pure renderer.

---

## 6. Challenges

**Colour was the biggest one, and I had it wrong.** Covered in §4 — the palette I'd have shipped on judgement was measurably unreadable for CVD users. Running the numbers forced the shape-family redesign, which turned out to make the graph more legible for _everyone_, not just as an accessibility fix.

**The force layout collapsed into a ball.** With default charge and link forces, region anchors at strength 0.07 were far too weak and every node piled onto the pinned client. Raising anchor strength to 0.16, scaling charge by influence, and making link distance inversely proportional to strength produced a layout with actual regional structure.

**Initial framing was guesswork and looked broken.** A hardcoded initial zoom rendered the graph as an unreadable speck in a large empty canvas, because the settled extent isn't knowable in advance. Replaced with `fitToBounds()`, which measures the real node extent and frames it — run early (tick 45), again as it relaxes (tick 140), on settle, and from the Reset view button.

**A genuine interaction bug: d3-drag silently eats clicks.** Clicking a node did nothing, while a programmatically dispatched click worked fine. The cause is that `d3-drag`'s default `clickDistance` is **0** — if the pointer moves so much as one pixel between press and release, the subsequent `click` event is suppressed. Every node here is draggable, so node selection was failing for anyone without a perfectly steady hand. Fixed with `.clickDistance(8)`.

(For anyone re-testing: the in-app browser's automated clicks were landing at scaled-up coordinates outside the viewport, which masked the above for a while. Interaction was ultimately verified by asserting on real DOM state — selecting Sonatrach lights exactly `Repsol, Government of Algeria, Sonatrach, Naturgy` and dims the other 31.)

---

## 7. Scope — what I cut, and why

The brief says a smaller scope done properly beats a long list done badly, and to say what was cut.

- **A timeline scrubber** (relationship states animating 2020→2026) was the most tempting addition and was cut deliberately. Done properly it means authoring a state history for all 54 edges — roughly doubling the data work — and done badly it's a slider that moves nothing meaningful. The `trajectory` field plus a dated `lastEvent` answers "where is it heading" for a fraction of the cost. This is the first thing I'd build with more time.
- **A backend, or any real data sourcing.** The brief says invent the data; a static JSON file is the honest shape for that.
- **Graph-wide keyboard traversal.** Tab-cycling 35 SVG nodes is a poor interaction anyway. The keyboard path is search → sidebar, where every connection is a real focusable button, plus Escape to clear.
- **Node aggregation / "Other" grouping.** At 35 nodes the clustering, filters and focus mode carry the legibility load. This would matter at 200.
- **Mobile-optimised graph interaction.** The layout stacks and stays usable below `lg`, but a pan-and-zoom exposure map is a desktop analytical tool and I didn't pretend otherwise.

---

## 8. Running it

Requires Node ≥ 20.9 and pnpm (the version is pinned in `packageManager`, so `corepack enable` is enough).

```bash
pnpm install
pnpm dev
```

| Script                         | What it does                                             |
| ------------------------------ | -------------------------------------------------------- |
| `pnpm dev`                     | dev server                                               |
| `pnpm build`                   | production build                                         |
| `pnpm lint`                    | ESLint (Next core-web-vitals + React hooks/purity rules) |
| `pnpm typecheck`               | `tsc --noEmit`                                           |
| `pnpm test`                    | Vitest, 84 tests                                         |
| `pnpm test:watch`              | Vitest in watch mode                                     |
| `pnpm test:coverage`           | V8 coverage over `src/lib`                               |
| `pnpm format` / `format:check` | Prettier                                                 |
| **`pnpm verify`**              | **everything CI runs, in order**                         |

Deploys to Vercel with no configuration and no environment variables.

### Dependency note

The app imports `d3-force`, `d3-zoom`, `d3-drag` and `d3-selection` as separate packages rather than the umbrella `d3` bundle. Under pnpm's strict `node_modules` layout, importing a submodule you don't directly depend on is a phantom dependency and fails to resolve — so they're explicit. It also drops the unused two-thirds of d3 from the bundle.

---

## 9. CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main`, every pull request, and on demand.

- **verify** — format check → lint → typecheck → test → build. Every step is marked `if: !cancelled()`, so one run reports _all_ the problems rather than surfacing them one push at a time.
- **coverage** — runs V8 coverage and uploads the report as an artifact.

In-flight runs are cancelled when a newer commit lands on the same ref, and `pnpm install --frozen-lockfile` means a lockfile that doesn't match `package.json` fails CI instead of quietly resolving to something else.

### On the tests

84 tests across three files, all pure — no DOM, no browser, ~600ms.

- **[`data.test.ts`](src/lib/__tests__/data.test.ts)** — the dataset is 700 lines of hand-authored JSON, which is exactly where a typo silently produces an edge pointing at nothing. Asserts referential integrity (no dangling refs, no self-loops, no orphans, no duplicate edges), value ranges, enum validity against every union in the type file, and required prose fields.
- **[`graph.test.ts`](src/lib/__tests__/graph.test.ts)** — the derivation helpers: adjacency symmetry, degree agreement, sort orders, leverage phrasing in all three directions, and the visual scales.
- **[`palette.test.ts`](src/lib/__tests__/palette.test.ts)** — guards the encoding invariants from §4: no two categories share both shape _and_ colour, colours stay distinct within each shape family, **no family exceeds three colours** (the validated all-pairs limit), only adverse states get a dash, and every trajectory has a distinct glyph so meaning never rests on colour alone.

Some of these assert claims this README makes. If someone prunes the data and turns the graph back into a hub-and-spoke star, or grows a shape family past the point where its colours stay CVD-separable, the write-up becomes wrong — so those claims are tested rather than trusted.

The suite was mutation-checked: reintroducing the `clientEdgesFor` `.find()` bug turns two tests red with a legible failure message, which is the point.
