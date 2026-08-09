import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from './worktree-default-display-name'
import type { MatchRange, PaletteSearchResult } from './worktree-palette-search'
import type { Worktree } from '../../../shared/types'

// Why: worktrees and open tabs are searched by separate scorers whose scales encode list position,
// so neither can say which section holds the better hit. Relevance is the one shared scale: which
// field matched, and where in it. Lower ranks first.
export const NO_MATCH_RELEVANCE = Number.MAX_SAFE_INTEGER

/** 0 = primary label, 1 = secondary line, 2 = ambient context (worktree, repo, snippet). */
export type PaletteRelevanceFieldTier = 0 | 1 | 2

export type PaletteRelevanceField = {
  text: string
  range: MatchRange | null
  tier: PaletteRelevanceFieldTier
}

// Why not \w: worktree names carry CJK and accented characters, which \w excludes — every match
// inside one would read as mid-word and sink below a Latin-only near-miss. \p{M} keeps decomposed
// accents (e + U+0301) attached to their base letter rather than reading as a separator.
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
    if (!field.range) {
      continue
    }
    best = Math.min(best, field.tier * POSITION_RANKS + positionRank(field.text, field.range))
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
      range: match.displayNameRange,
      tier: 0
    },
    {
      text: resolveWorktreeBranchLabel(worktree),
      range: match.branchRange,
      tier: 1
    },
    {
      text: match.supportingText?.text ?? '',
      range: match.supportingText?.matchRange ?? null,
      tier: 2
    },
    { text: repoName, range: match.repoRange, tier: 2 }
  ])
}

/** Structural shape shared by the browser-page, simulator-tab, and workspace-tab result types. */
export type OpenTabRelevanceInput = {
  title: string
  titleRange: MatchRange | null
  secondaryText: string
  secondaryRange: MatchRange | null
  worktreeName: string
  worktreeRange: MatchRange | null
  repoName: string
  repoRange: MatchRange | null
  workspaceLabel?: string | null
  workspaceRange?: MatchRange | null
  /**
   * Search-only type label match (e.g. "terminal tab" / "mobile emulator").
   * Not rendered on the row — still needs a relevance field so section leadership
   * and open-tab sort don't treat the hit as unmatched.
   */
  typeAliasMatch?: { text: string; range: MatchRange } | null
}

export function getOpenTabMatchRelevance(result: OpenTabRelevanceInput): number {
  return scorePaletteRelevance([
    { text: result.title, range: result.titleRange, tier: 0 },
    { text: result.secondaryText, range: result.secondaryRange, tier: 1 },
    {
      text: result.typeAliasMatch?.text ?? '',
      range: result.typeAliasMatch?.range ?? null,
      tier: 1
    },
    {
      text: result.workspaceLabel ?? '',
      range: result.workspaceRange ?? null,
      tier: 2
    },
    { text: result.worktreeName, range: result.worktreeRange, tier: 2 },
    { text: result.repoName, range: result.repoRange, tier: 2 }
  ])
}
