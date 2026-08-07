import { z } from 'zod'

import { computeMetrics, findPaths, type NodeMetrics } from '@/lib/analytics'
import { edgeKey } from '@/lib/graph'
import type { ToolDefinition } from '@/lib/llm/client'
import type { GraphData, RelationshipEdge } from '@/lib/types'
import { REL_STATES, REL_TYPES, TRAJECTORIES } from '@/lib/types'

/**
 * The copilot's tools: structured queries over the graph, not vector search.
 *
 * Design spec §6.1 — "how does OFAC reach Repsol?" is a traversal, not a
 * similarity lookup, and the graph is already a precise structured index. Every
 * tool here is a deterministic read; none of them costs credits by itself.
 *
 * Two properties matter more than the tool list:
 *
 * 1. **Everything returned carries its id.** `node_id` on every entity,
 *    `edge_id` (source->target:type, the same key the renderer's focus mode
 *    uses) on every relationship. That is what makes an answer citable, and
 *    later — Phase 8 — clickable.
 * 2. **Ids returned are recorded.** The runner accumulates the ids it has
 *    handed the model, which is what lets the agent verify that a citation
 *    refers to something a tool actually returned rather than something the
 *    model invented.
 */

export interface CopilotContext {
  graph: GraphData
  /** Precomputed so repeated tool calls in one question don't recompute. */
  metrics: Map<string, NodeMetrics>
  /** Revision history for one relationship. Injected so tools stay pure. */
  timeline: (
    source: string,
    target: string,
    type: RelationshipEdge['type'],
  ) => Promise<
    Array<{
      field: string
      oldValue: string | null
      newValue: string | null
      appliedAt: string
    }>
  >
}

/** Marks a tool result the model should treat as a failed query, not data. */
export class ToolArgumentError extends Error {}

const stateEnum = z.enum(REL_STATES)
const trajectoryEnum = z.enum(TRAJECTORIES)
const typeEnum = z.enum(REL_TYPES)

const schemas = {
  search_entities: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  get_node: z.object({ node_id: z.string().min(1) }),
  get_relationships: z.object({
    node_id: z.string().min(1),
    state: stateEnum.optional(),
    trajectory: trajectoryEnum.optional(),
    min_strength: z.number().min(0).max(100).optional(),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  find_paths: z.object({
    from_id: z.string().min(1),
    to_id: z.string().min(1),
    max_hops: z.number().int().min(1).max(4).optional(),
  }),
  get_metrics: z.object({
    node_id: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(15).optional(),
  }),
  filter_edges: z.object({
    state: stateEnum.optional(),
    trajectory: trajectoryEnum.optional(),
    type: typeEnum.optional(),
    min_strength: z.number().min(0).max(100).optional(),
    limit: z.number().int().min(1).max(25).optional(),
  }),
  get_timeline: z.object({ edge_id: z.string().min(1) }),
} as const

export type ToolName = keyof typeof schemas

/*
 * JSON Schema mirrors of the zod schemas above, sent to the provider as the
 * tool definitions. Same two-form arrangement as src/lib/ingest/schemas.ts and
 * for the same reason: the provider enforces the wire schema, we validate the
 * arguments again on arrival rather than trusting them. Every property carries
 * a description — Phase 5 showed that a bare schema gets semantically wrong
 * arguments even when it gets structurally valid ones.
 */
const num = (description: string) => ({ type: 'number', description })
const str = (description: string) => ({ type: 'string', description })
const enumOf = (values: readonly string[], description: string) => ({
  type: 'string',
  enum: [...values],
  description,
})

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'search_entities',
    description:
      'Find stakeholders by name, role, country or region. Use this FIRST to turn a ' +
      'name mentioned by the user into a node_id — every other tool takes ids, not names.',
    parameters: {
      type: 'object',
      properties: {
        query: str('Free text matched against name, role, country and region.'),
        limit: num('Maximum results. Default 6.'),
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_node',
    description:
      'Full detail for one stakeholder, including its structural metrics and how many ' +
      'relationships it holds.',
    parameters: {
      type: 'object',
      properties: { node_id: str('Node id, as returned by search_entities.') },
      required: ['node_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_relationships',
    description:
      'Every relationship touching one stakeholder, strongest first, with the ' +
      'counterpart resolved. Optional filters narrow by state, trajectory or strength.',
    parameters: {
      type: 'object',
      properties: {
        node_id: str('Node id whose relationships to list.'),
        state: enumOf(REL_STATES, 'Only relationships currently in this state.'),
        trajectory: enumOf(TRAJECTORIES, 'Only relationships heading this way.'),
        min_strength: num('Only relationships at or above this strength (0-100).'),
        limit: num('Maximum results. Default 6.'),
      },
      required: ['node_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_paths',
    description:
      'How two stakeholders are connected: every route between them up to max_hops, ' +
      'shortest first. Use this for "how does X reach Y" — do not guess a route.',
    parameters: {
      type: 'object',
      properties: {
        from_id: str('Starting node id.'),
        to_id: str('Destination node id.'),
        max_hops: num('Maximum edges in a path. Default 3, maximum 4.'),
      },
      required: ['from_id', 'to_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_metrics',
    description:
      'Structural metrics. With node_id, the metrics for that one actor; without it, ' +
      'the top chokepoints by betweenness — the actors exposure routes through.',
    parameters: {
      type: 'object',
      properties: {
        node_id: str('Optional. Omit to get the ranked chokepoint list.'),
        limit: num('How many actors to rank when node_id is omitted. Default 5.'),
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'filter_edges',
    description:
      'Relationships across the whole graph matching a filter, strongest first. Use ' +
      'for portfolio questions such as "what is deteriorating" rather than per-actor ones.',
    parameters: {
      type: 'object',
      properties: {
        state: enumOf(REL_STATES, 'Only relationships currently in this state.'),
        trajectory: enumOf(TRAJECTORIES, 'Only relationships heading this way.'),
        type: enumOf(REL_TYPES, 'Only relationships of this type.'),
        min_strength: num('Only relationships at or above this strength (0-100).'),
        limit: num('Maximum results. Default 6.'),
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_timeline',
    description:
      'One relationship in full — its untrimmed narrative and exposure — plus every ' +
      'recorded change to it, newest first. Use it when a list result was clipped and ' +
      'the full text matters. The change list is empty if it has never been revised.',
    parameters: {
      type: 'object',
      properties: { edge_id: str('Edge id in the form source->target:type.') },
      required: ['edge_id'],
      additionalProperties: false,
    },
  },
]

// --- result shaping ---------------------------------------------------------

/*
 * Tool results are trimmed deliberately. The model pays for every token of
 * every result on every subsequent turn, and the full node/edge records carry
 * long prose fields the model rarely needs to answer a structural question.
 * Narrative and exposure ARE included on edges, because those are what an
 * answer actually quotes.
 */
function shapeNode(g: GraphData, id: string, metrics: Map<string, NodeMetrics>) {
  const n = g.nodes.find((x) => x.id === id)
  if (!n) return null
  const m = metrics.get(id)
  return {
    node_id: n.id,
    name: n.name,
    category: n.category,
    country: n.country,
    region: n.region,
    influence: n.influence,
    role: n.role,
    description: n.description,
    key_people: n.keyPeople ?? [],
    metrics: m
      ? {
          betweenness: Number(m.betweenness.toFixed(4)),
          degree: m.degree,
          eigenvector: Number(m.eigenvector.toFixed(4)),
          community: m.community,
        }
      : null,
  }
}

/** Cuts long prose at a word boundary so a list result stays affordable. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${cut.slice(0, space > max * 0.6 ? space : max).trimEnd()}…`
}

/**
 * One relationship, shaped for the model.
 *
 * `detail: 'list'` is the default because most calls return several edges and
 * every one of them is resent with every later turn. The narrative and the
 * last event are the fields that run long, so in list form they are clipped —
 * enough to judge and quote a phrase from, not the full analyst write-up. A
 * question that needs the whole text can ask for the one relationship.
 */
function shapeEdge(g: GraphData, e: RelationshipEdge, detail: 'list' | 'full' = 'list') {
  const name = (id: string) => g.nodes.find((n) => n.id === id)?.name ?? id
  const full = detail === 'full'
  return {
    edge_id: edgeKey(e),
    source_id: e.source,
    source_name: name(e.source),
    target_id: e.target,
    target_name: name(e.target),
    type: e.type,
    direction: e.direction,
    strength: e.strength,
    state: e.state,
    trajectory: e.trajectory,
    exposure: full ? e.exposure : clip(e.exposure, 140),
    since: e.since,
    last_event: full
      ? e.lastEvent
      : { date: e.lastEvent.date, summary: clip(e.lastEvent.summary, 140) },
    narrative: full ? e.narrative : clip(e.narrative, 180),
    confidence: e.confidence,
  }
}

export interface ToolRunResult {
  name: string
  args: unknown
  result: unknown
  /** True when the call failed in a way the model is expected to recover from. */
  isError: boolean
}

/**
 * Executes tool calls against one dataset and remembers what it returned.
 *
 * Bad arguments come back as a tool *result* describing the problem rather
 * than as a thrown error: a model that passed a name where an id was wanted
 * can fix that on the next turn, and failing the whole request would turn a
 * recoverable mistake into a refunded 500.
 */
export function createToolRunner(ctx: CopilotContext) {
  const groundedNodeIds = new Set<string>()
  const groundedEdgeIds = new Set<string>()
  const runs: ToolRunResult[] = []

  const recordNode = (id: string) => groundedNodeIds.add(id)
  const recordEdge = (e: RelationshipEdge) => {
    groundedEdgeIds.add(edgeKey(e))
    recordNode(e.source)
    recordNode(e.target)
  }

  async function dispatch(name: string, rawArgs: string): Promise<unknown> {
    const schema = schemas[name as ToolName]
    if (!schema) {
      throw new ToolArgumentError(
        `Unknown tool "${name}". Available: ${Object.keys(schemas).join(', ')}.`,
      )
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(rawArgs || '{}')
    } catch {
      throw new ToolArgumentError(`Arguments for ${name} were not valid JSON: ${rawArgs}`)
    }

    const parsed = schema.safeParse(parsedJson)
    if (!parsed.success) {
      throw new ToolArgumentError(
        `Invalid arguments for ${name}: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      )
    }

    const g = ctx.graph
    const args = parsed.data

    switch (name as ToolName) {
      case 'search_entities': {
        const { query, limit = 6 } = args as z.infer<typeof schemas.search_entities>
        const q = query.trim().toLowerCase()
        const matches = g.nodes
          .filter((n) =>
            `${n.name} ${n.role} ${n.country} ${n.region} ${n.category}`
              .toLowerCase()
              .includes(q),
          )
          .sort((a, b) => b.influence - a.influence)
          .slice(0, limit)
        for (const n of matches) recordNode(n.id)
        return {
          matches: matches.map((n) => ({
            node_id: n.id,
            name: n.name,
            category: n.category,
            country: n.country,
            region: n.region,
            influence: n.influence,
            role: n.role,
          })),
        }
      }

      case 'get_node': {
        const { node_id } = args as z.infer<typeof schemas.get_node>
        const node = shapeNode(g, node_id, ctx.metrics)
        if (!node) throw new ToolArgumentError(`No node with id "${node_id}".`)
        recordNode(node_id)
        const relationshipCount = g.edges.filter(
          (e) => e.source === node_id || e.target === node_id,
        ).length
        return { ...node, relationship_count: relationshipCount }
      }

      case 'get_relationships': {
        const {
          node_id,
          state,
          trajectory,
          min_strength = 0,
          limit = 6,
        } = args as z.infer<typeof schemas.get_relationships>
        if (!g.nodes.some((n) => n.id === node_id)) {
          throw new ToolArgumentError(`No node with id "${node_id}".`)
        }
        recordNode(node_id)
        const matches = g.edges
          .filter((e) => e.source === node_id || e.target === node_id)
          .filter((e) => (state ? e.state === state : true))
          .filter((e) => (trajectory ? e.trajectory === trajectory : true))
          .filter((e) => e.strength >= min_strength)
          .sort((a, b) => b.strength - a.strength)
          .slice(0, limit)
        for (const e of matches) recordEdge(e)
        return { node_id, relationships: matches.map((e) => shapeEdge(g, e)) }
      }

      case 'find_paths': {
        const { from_id, to_id, max_hops = 3 } = args as z.infer<typeof schemas.find_paths>
        for (const id of [from_id, to_id]) {
          if (!g.nodes.some((n) => n.id === id)) {
            throw new ToolArgumentError(`No node with id "${id}".`)
          }
        }
        const paths = findPaths(g, from_id, to_id, max_hops)
        const shaped = paths.map((ids) => {
          for (const id of ids) recordNode(id)
          const hops = []
          for (let i = 0; i < ids.length - 1; i++) {
            const a = ids[i]
            const b = ids[i + 1]
            /*
             * A hop may be served by several parallel relationships (partner
             * AND competitor). All of them are returned: which one carries the
             * exposure is exactly the judgement the answer needs to make, and
             * silently picking the first would make that judgement for it.
             */
            const between = g.edges.filter(
              (e) => (e.source === a && e.target === b) || (e.source === b && e.target === a),
            )
            for (const e of between) recordEdge(e)
            hops.push({ from: a, to: b, via: between.map((e) => shapeEdge(g, e)) })
          }
          return { node_ids: ids, hops }
        })
        return { from_id, to_id, path_count: shaped.length, paths: shaped }
      }

      case 'get_metrics': {
        const { node_id, limit = 5 } = args as z.infer<typeof schemas.get_metrics>
        if (node_id) {
          const m = ctx.metrics.get(node_id)
          if (!m) throw new ToolArgumentError(`No node with id "${node_id}".`)
          recordNode(node_id)
          return {
            node_id,
            betweenness: Number(m.betweenness.toFixed(4)),
            degree: m.degree,
            eigenvector: Number(m.eigenvector.toFixed(4)),
            community: m.community,
          }
        }
        const ranked = [...ctx.metrics.entries()]
          .sort((a, b) => b[1].betweenness - a[1].betweenness)
          .slice(0, limit)
        for (const [id] of ranked) recordNode(id)
        return {
          note: 'Ranked by betweenness — the actors the most shortest paths run through.',
          chokepoints: ranked.map(([id, m]) => ({
            node_id: id,
            name: g.nodes.find((n) => n.id === id)?.name ?? id,
            betweenness: Number(m.betweenness.toFixed(4)),
            degree: m.degree,
          })),
        }
      }

      case 'filter_edges': {
        const {
          state,
          trajectory,
          type,
          min_strength = 0,
          limit = 6,
        } = args as z.infer<typeof schemas.filter_edges>
        const matches = g.edges
          .filter((e) => (state ? e.state === state : true))
          .filter((e) => (trajectory ? e.trajectory === trajectory : true))
          .filter((e) => (type ? e.type === type : true))
          .filter((e) => e.strength >= min_strength)
          .sort((a, b) => b.strength - a.strength)
          .slice(0, limit)
        for (const e of matches) recordEdge(e)
        return {
          match_count: matches.length,
          relationships: matches.map((e) => shapeEdge(g, e)),
        }
      }

      case 'get_timeline': {
        const { edge_id } = args as z.infer<typeof schemas.get_timeline>
        const edge = g.edges.find((e) => edgeKey(e) === edge_id)
        if (!edge) {
          throw new ToolArgumentError(
            `No relationship with edge_id "${edge_id}". Edge ids look like ` +
              `source->target:type and come from get_relationships or filter_edges.`,
          )
        }
        recordEdge(edge)
        const entries = await ctx.timeline(edge.source, edge.target, edge.type)
        return {
          edge_id,
          // The one place a relationship comes back untrimmed: this tool asks
          // about a single edge, so the full narrative and exposure are cheap
          // here in a way they are not in a list of six.
          relationship: shapeEdge(g, edge, 'full'),
          /* The seeded fixture has no revision history; say so rather than
           * returning an empty list the model might read as "nothing changed". */
          note:
            entries.length === 0
              ? 'No recorded revisions — this relationship has not changed since it was created.'
              : undefined,
          revisions: entries,
        }
      }
    }
  }

  return {
    definitions: TOOL_DEFINITIONS,

    async execute(name: string, rawArgs: string): Promise<ToolRunResult> {
      let run: ToolRunResult
      try {
        const result = await dispatch(name, rawArgs)
        run = { name, args: rawArgs, result, isError: false }
      } catch (err) {
        if (!(err instanceof ToolArgumentError)) throw err
        run = { name, args: rawArgs, result: { error: err.message }, isError: true }
      }
      runs.push(run)
      return run
    },

    /** Ids the model has actually been shown — the grounding set for citations. */
    get grounding() {
      return { nodeIds: groundedNodeIds, edgeIds: groundedEdgeIds }
    },
    get runs() {
      return runs
    },
  }
}

export type ToolRunner = ReturnType<typeof createToolRunner>

/** Builds a context from an already-loaded graph. The DB-backed one is in context.ts. */
export function contextFromGraph(
  graph: GraphData,
  timeline: CopilotContext['timeline'] = async () => [],
): CopilotContext {
  return { graph, metrics: computeMetrics(graph), timeline }
}
