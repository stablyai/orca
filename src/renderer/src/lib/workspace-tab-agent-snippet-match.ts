import {
  mapNormalizedRange,
  mergeMatchRanges,
  normalizePaletteText,
  type MatchRange
} from './palette-match/normalized-text'
import {
  PALETTE_MATCH_QUALITIES,
  paletteMatchQualityRank,
  type PaletteMatchQuality
} from './palette-match/match-quality'
import type { PaletteDocumentRank } from './palette-match/palette-document'
import type { PaletteQueryToken } from './palette-match/palette-query'
import type { AgentMetadata } from './workspace-tab-agent-metadata'

/**
 * Agent prompts and assistant messages are deliberately outside the structured tab
 * matcher — they have no evidence contract and no performance gate yet. This
 * fallback preserves the pre-existing ability to find a terminal by what its agent
 * said, as a strictly last-place tier that never contributes to token coverage.
 */
const AGENT_SNIPPET_RANK: PaletteDocumentRank = {
  exactIntent: 1,
  containerOnlyTokenCount: Number.MAX_SAFE_INTEGER,
  wholeQuery: 3,
  worstQuality: paletteMatchQualityRank(PALETTE_MATCH_QUALITIES.at(-1) as PaletteMatchQuality) + 1,
  usesSupportingEvidence: 1,
  fuzzyTokenCount: 0,
  fieldHopCount: Number.MAX_SAFE_INTEGER
}

export type WorkspaceTabAgentSnippetMatch = {
  text: string
  ranges: readonly MatchRange[]
  rank: PaletteDocumentRank
}

function coverAllTokens(text: string, tokens: readonly PaletteQueryToken[]): MatchRange[] | null {
  // Why the cheap path first: this tier runs over long agent text for every row the
  // structured matcher rejected, so full folding is reserved for strings that need it.
  const lowered = text.toLowerCase()
  const folded = lowered.length === text.length ? null : normalizePaletteText(text)
  const haystack = folded ? folded.normalized : lowered
  const ranges: MatchRange[] = []
  for (const token of tokens) {
    if (token.isPunctuationOnly) {
      return null
    }
    const index = haystack.indexOf(token.text)
    if (index === -1) {
      return null
    }
    const end = index + token.text.length
    ranges.push(folded ? mapNormalizedRange(folded, index, end) : { start: index, end })
  }
  return mergeMatchRanges(ranges)
}

export function matchWorkspaceTabAgentSnippet(
  agentMetadata: readonly AgentMetadata[],
  query: { tokens: readonly PaletteQueryToken[] }
): WorkspaceTabAgentSnippetMatch | null {
  for (const source of ['snippetCandidates', 'textParts'] as const) {
    for (const metadata of agentMetadata) {
      for (const text of metadata[source]) {
        const ranges = coverAllTokens(text, query.tokens)
        if (ranges) {
          return { text, ranges, rank: AGENT_SNIPPET_RANK }
        }
      }
    }
  }
  return null
}
