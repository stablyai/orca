import {
  mapNormalizedRange,
  mergeMatchRanges,
  normalizePaletteText,
  type MatchRange
} from '../../../shared/palette-match/normalized-text'
import {
  createPaletteFallbackRank,
  type PaletteDocumentRank
} from '../../../shared/palette-match/palette-document'
import type { PaletteQueryToken } from '../../../shared/palette-match/palette-query'
import type { AgentMetadata } from './workspace-tab-agent-metadata'

/** Keep agent-text fallback last and outside token coverage; it preserves snippet search until structured evidence/performance contracts exist. */
const AGENT_SNIPPET_RANK: PaletteDocumentRank = createPaletteFallbackRank()

export type WorkspaceTabAgentSnippetMatch = {
  text: string
  ranges: readonly MatchRange[]
  rank: PaletteDocumentRank
}

function coverAllTokens(text: string, tokens: readonly PaletteQueryToken[]): MatchRange[] | null {
  // Use cheap matching before full folding on long agent text rejected by structured matching.
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
