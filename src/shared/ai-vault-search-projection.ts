import {
  OutboundSessionSearchHitSchema,
  OutboundSessionSearchResultSchema
} from './ai-vault-search-contract'
import type { AiVaultSearchResult } from './ai-vault-search-types'
import {
  AI_VAULT_SEARCH_LIMIT_MAX,
  AI_VAULT_SEARCH_SNIPPET_MARK_CLOSE,
  AI_VAULT_SEARCH_SNIPPET_MARK_OPEN
} from './ai-vault-search-types'

const MAX_SNIPPET_BYTES = 4096
const MAX_RESPONSE_BYTES = 512 * 1024
// Metadata alone (coverage, counters) must leave room for at least some hits.
const MAX_METADATA_BYTES = 64 * 1024
// The `{"hits":[ ... ]}` framing the per-hit sizes below do not include.
const RESPONSE_ENVELOPE_BYTES = 256

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function snippet(text: string): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= MAX_SNIPPET_BYTES) {
    return text
  }
  let end = MAX_SNIPPET_BYTES
  while (end > 0) {
    try {
      return balanceMarks(decoder.decode(bytes.subarray(0, end)))
    } catch {
      end--
    }
  }
  return ''
}

/** A cut between `[[` and `]]` hands the renderer a mark it can never close. */
function balanceMarks(text: string): string {
  const opened = text.lastIndexOf(AI_VAULT_SEARCH_SNIPPET_MARK_OPEN)
  return opened !== -1 && !text.includes(AI_VAULT_SEARCH_SNIPPET_MARK_CLOSE, opened)
    ? text.slice(0, opened)
    : text
}

/**
 * Bound before every host transport; never shorten session identities or resume
 * paths. Validated against the strict outbound schema, so a producer bug throws
 * here instead of travelling as a plausible-looking fallback.
 */
export function projectSessionSearchResult(result: AiVaultSearchResult): AiVaultSearchResult {
  const metadata = OutboundSessionSearchResultSchema.parse({ ...result, hits: [] })
  const hits: AiVaultSearchResult['hits'] = []
  let truncatedSnippets = result.truncatedSnippets ?? 0
  let omittedHits = result.omittedHits ?? 0
  let bytes = encoder.encode(JSON.stringify(metadata)).length + RESPONSE_ENVELOPE_BYTES
  if (bytes > MAX_METADATA_BYTES) {
    throw new Error('Search metadata exceeds the response limit.')
  }
  for (const hit of result.hits) {
    const text = snippet(hit.evidence.snippet)
    const projected = { ...hit, evidence: { ...hit.evidence, snippet: text } }
    const size = encoder.encode(JSON.stringify(projected)).length + 1
    if (
      hits.length >= AI_VAULT_SEARCH_LIMIT_MAX ||
      bytes + size > MAX_RESPONSE_BYTES ||
      !OutboundSessionSearchHitSchema.safeParse(projected).success
    ) {
      omittedHits++
      continue
    }
    if (text !== hit.evidence.snippet) {
      truncatedSnippets++
    }
    bytes += size
    hits.push(projected)
  }
  return OutboundSessionSearchResultSchema.parse({
    ...result,
    hits,
    ...(omittedHits ? { omittedHits } : {}),
    ...(truncatedSnippets ? { truncatedSnippets } : {})
  })
}
