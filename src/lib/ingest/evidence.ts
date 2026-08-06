/**
 * The evidence check — a cheap, deterministic, non-LLM guard against the most
 * dangerous failure mode in the pipeline: a fabricated quote attached to a
 * real source URL (design spec §4.1/§4.2). A proposal whose evidenceQuote does
 * not actually appear in the source is auto-rejected before a human ever sees
 * it.
 *
 * Normalisation is deliberately narrow: collapse whitespace and match
 * case-insensitively, because a model may reflow line breaks or alter case
 * when copying, but the phrase itself must still appear — this is a verbatim
 * check, not a fuzzy one. A paraphrase must fail.
 */

function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function verifyEvidenceQuote(quote: string | null, sourceBody: string): boolean {
  if (!quote || quote.trim().length === 0) return false
  return normalise(sourceBody).includes(normalise(quote))
}
