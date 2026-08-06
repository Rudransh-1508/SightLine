import { z } from 'zod'

import { REL_STATES, REL_TYPES, DIRECTIONS, TRAJECTORIES, CONFIDENCES } from '@/lib/types'

/**
 * Each schema below exists in two forms that must agree: a JSON Schema (sent
 * to OpenRouter as response_format, enforced by the provider) and a zod schema
 * (validated on the way back in, per design spec §4's "malformed model output"
 * failure mode — reject and log, do not trust structured output blindly just
 * because it parsed as JSON). schemas.test.ts checks the two stay in sync.
 */

// --- triage -----------------------------------------------------------------

export const triageResponseSchema = z.object({
  results: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      relevant: z.boolean(),
    }),
  ),
})

export type TriageResponse = z.infer<typeof triageResponseSchema>

export const triageJsonSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: {
            type: 'integer',
            description: 'Position of the document in the input list.',
          },
          relevant: {
            type: 'boolean',
            description:
              'True only if the document is substantively ABOUT a relationship or status ' +
              'change involving a tracked entity — not merely a passing mention.',
          },
        },
        required: ['index', 'relevant'],
        additionalProperties: false,
      },
    },
  },
  required: ['results'],
  additionalProperties: false,
} as const

// --- extraction ---------------------------------------------------------

/*
 * The 2026-08-06 smoke test (see design spec §3.4.2) showed schema conformance
 * is reliable but semantic accuracy is not, absent field descriptions — a bare
 * schema put both entity names in one field. Every property below therefore
 * carries a `description` that states what it means, not just its type.
 */
export const extractionResponseSchema = z.object({
  found: z
    .boolean()
    .describe('False if the document contains no proposable relationship change.'),
  sourceEntity: z.string().nullable(),
  targetEntity: z.string().nullable(),
  relationshipType: z.enum(REL_TYPES).nullable(),
  direction: z.enum(DIRECTIONS).nullable(),
  strength: z.number().int().min(0).max(100).nullable(),
  state: z.enum(REL_STATES).nullable(),
  trajectory: z.enum(TRAJECTORIES).nullable(),
  exposure: z.string().nullable(),
  narrative: z.string().nullable(),
  confidence: z.enum(CONFIDENCES).nullable(),
  /** Must appear verbatim in the source text — checked by evidence.ts before staging. */
  evidenceQuote: z.string().nullable(),
})

export type ExtractionResponse = z.infer<typeof extractionResponseSchema>

export const extractionJsonSchema = {
  type: 'object',
  properties: {
    found: {
      type: 'boolean',
      description:
        'False if this document does not describe a specific, attributable relationship ' +
        'or status change between two named organisations or people. Most documents that ' +
        'merely mention an entity in passing should set this to false.',
    },
    sourceEntity: {
      type: ['string', 'null'],
      description:
        'The FIRST named organisation or person in the relationship, exactly as named in ' +
        'the source text. Never combine two entity names into this field.',
    },
    targetEntity: {
      type: ['string', 'null'],
      description:
        'The SECOND named organisation or person in the relationship — the counterpart to ' +
        'sourceEntity. Must be a different entity from sourceEntity.',
    },
    relationshipType: {
      type: ['string', 'null'],
      enum: [...REL_TYPES, null],
      description: 'The nature of the relationship described.',
    },
    direction: {
      type: ['string', 'null'],
      enum: [...DIRECTIONS, null],
      description:
        "Who depends on whom. 'source-depends' if sourceEntity needs targetEntity more than " +
        "the reverse, 'target-depends' for the opposite, 'mutual' if roughly symmetric.",
    },
    strength: {
      type: ['integer', 'null'],
      description:
        "How much of sourceEntity's position rides on this relationship, 0-100. Estimate from " +
        'context — e.g. "sole supplier of a critical input" is high; "one of many customers" is low.',
    },
    state: {
      type: ['string', 'null'],
      enum: [...REL_STATES, null],
      description: 'How the relationship is doing RIGHT NOW, per this document.',
    },
    trajectory: {
      type: ['string', 'null'],
      enum: [...TRAJECTORIES, null],
      description:
        'Whether the relationship is described as getting better, worse, or unchanged.',
    },
    exposure: {
      type: ['string', 'null'],
      description:
        "What is concretely at stake, in the source text's own terms (e.g. a figure, a contract, a share of supply).",
    },
    narrative: {
      type: ['string', 'null'],
      description:
        'A 1-2 sentence neutral summary of what this document reports about the relationship.',
    },
    confidence: {
      type: ['string', 'null'],
      enum: [...CONFIDENCES, null],
      description:
        "'high' if the document states this directly and unambiguously, 'medium' if it is " +
        "implied or reported secondhand, 'low' if speculative.",
    },
    evidenceQuote: {
      type: ['string', 'null'],
      description:
        'A short quotation copied VERBATIM from the source document that supports this ' +
        'extraction. Must be an exact substring of the source text — do not paraphrase, ' +
        'summarise, or combine text from different parts of the document.',
    },
  },
  required: [
    'found',
    'sourceEntity',
    'targetEntity',
    'relationshipType',
    'direction',
    'strength',
    'state',
    'trajectory',
    'exposure',
    'narrative',
    'confidence',
    'evidenceQuote',
  ],
  additionalProperties: false,
} as const
