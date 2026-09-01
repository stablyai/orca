import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import type { MatchRange, PaletteSearchResult } from './worktree-palette-search'
import type { Worktree } from '../../../shared/worktree/types'

/** A missing match sorts after every concrete field match. */
export const NO_MATCH_RELEVANCE = Number.MAX_SAFE_INTEGER

export type PaletteRelevanceFieldTier = 0 | 1 | 2

export type PaletteRelevanceField = {
  text: string
  ranges: readonly MatchRange[]
  tier: PaletteRelevanceFieldTier
}

const NON_WORD_CHARACTER = /[^\p{L}\p{M}\p{N}]/u
const POSITION_RANKS = 4

function positionRank(text: string, range: MatchRange): number {
  if (range.start === 0) {
    return range.end >= text.trimEnd().length ? 0 : 1
  }
  return NON_WORD_CHARACTER.test(text[range.start - 1] ?? '') ? 2 : 3
}

export function scorePaletteRelevance(fields: readonly PaletteRelevanceField[]): number {
  let best = NO_MATCH_RELEVANCE
  for (const field of fields) {
    for (const range of field.ranges) {
      best = Math.min(best, field.tier * POSITION_RANKS + positionRank(field.text, range))
    }
  }
  return best
}

export function getWorktreeMatchRelevance(
  match: PaletteSearchResult,
  worktree: Worktree,
  repoName: string
): number {
  return scorePaletteRelevance([
    {
      text: resolveWorktreeDisplayName(worktree),
      ranges: match.displayNameRanges,
      tier: 0
    },
    {
      text: resolveWorktreeBranchLabel(worktree),
      ranges: match.branchRanges,
      tier: 1
    },
    {
      text: match.supportingText?.text ?? '',
      ranges: match.supportingText?.matchRanges ?? [],
      tier: 2
    },
    { text: repoName, ranges: match.repoRanges, tier: 2 }
  ])
}

/** Structural shape shared by browser, simulator, and workspace-tab results. */
export type OpenTabRelevanceInput = {
  title: string
  titleRanges: readonly MatchRange[]
  secondaryText: string
  secondaryRanges: readonly MatchRange[]
  worktreeName: string
  worktreeRanges: readonly MatchRange[]
  repoName: string
  repoRanges: readonly MatchRange[]
  workspaceLabel?: string | null
  workspaceRanges?: readonly MatchRange[]
  typeAliasMatch?: { text: string; ranges: readonly MatchRange[] } | null
}

export function getOpenTabMatchRelevance(result: OpenTabRelevanceInput): number {
  return scorePaletteRelevance([
    { text: result.title, ranges: result.titleRanges, tier: 0 },
    { text: result.secondaryText, ranges: result.secondaryRanges, tier: 1 },
    {
      text: result.typeAliasMatch?.text ?? '',
      ranges: result.typeAliasMatch?.ranges ?? [],
      tier: 1
    },
    {
      text: result.workspaceLabel ?? '',
      ranges: result.workspaceRanges ?? [],
      tier: 2
    },
    { text: result.worktreeName, ranges: result.worktreeRanges, tier: 2 },
    { text: result.repoName, ranges: result.repoRanges, tier: 2 }
  ])
}
