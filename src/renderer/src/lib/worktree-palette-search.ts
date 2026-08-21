import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { matchPaletteDocument } from './palette-match/match-document'
import { preparePaletteQuery } from './palette-match/palette-query'
import type { MatchRange } from './palette-match/normalized-text'
import type { PaletteResultQualityClass } from './palette-match/match-quality'
import type {
  PaletteDocument,
  PaletteDocumentMatch,
  PaletteDocumentRank
} from './palette-match/palette-document'
import {
  buildWorktreePaletteDocuments,
  WORKTREE_PALETTE_BRANCH_FIELD_ID,
  WORKTREE_PALETTE_HOST_FIELD_ID,
  WORKTREE_PALETTE_NAME_FIELD_ID,
  WORKTREE_PALETTE_REPO_FIELD_ID,
  type IssueCacheEntry,
  type PRCacheEntry,
  type WorktreePaletteDocumentSources
} from './worktree-palette-document'
import {
  applyWorktreeCommentSnippet,
  type PaletteSupportingKind
} from './worktree-palette-evidence'
import type { HostedReviewInfo } from '../../../shared/hosted-review'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { resolvePaletteRepoForWorktree } from './palette-repo-resolution'
import {
  matchWorktreePaletteTaskUrl,
  parseCmdJTaskSourceUrl
} from './worktree-palette-task-url-match'

export type { MatchRange }

export type PaletteMatchedField = 'displayName' | 'branch' | 'repo' | 'host' | PaletteSupportingKind

export type PaletteSupportingText = {
  labelKind: PaletteSupportingKind
  text: string
  matchRanges: readonly MatchRange[]
  accessibilityLabel: string
}

export type PaletteSearchResult = {
  worktreeId: string
  /** Why (STA-4343): `repoId::path` repeats across hosts, so consumers that key on a
   *  result — board filters, item ids — need the host to tell two rows apart. */
  worktreeHostId?: Worktree['hostId']
  matchedFields: readonly PaletteMatchedField[]
  displayNameRanges: readonly MatchRange[]
  branchRanges: readonly MatchRange[]
  repoRanges: readonly MatchRange[]
  hostRanges: readonly MatchRange[]
  supportingText: PaletteSupportingText | null
  /** null for the empty query, where every worktree is listed without a match. */
  qualityClass: PaletteResultQualityClass | null
  rank: PaletteDocumentRank | null
}

const NO_RANGES: readonly MatchRange[] = []

export function getWorktreePaletteSearchScope(args: {
  hasQuery: boolean
  allWorktrees: readonly Worktree[]
  emptyQueryWorktrees: readonly Worktree[]
}): Worktree[] {
  if (!args.hasQuery) {
    return [...args.emptyQueryWorktrees]
  }

  // Why: sidebar filters keep the default list quiet, but explicit search is
  // a recovery path for sleeping/default-branch workspaces hidden by filters.
  return args.allWorktrees.filter((worktree) => !worktree.isArchived)
}

export function makeEmptyPaletteSearchResult(
  worktreeId: string,
  worktreeHostId?: Worktree['hostId']
): PaletteSearchResult {
  return {
    worktreeId,
    ...(worktreeHostId ? { worktreeHostId } : {}),
    matchedFields: [],
    displayNameRanges: NO_RANGES,
    branchRanges: NO_RANGES,
    repoRanges: NO_RANGES,
    hostRanges: NO_RANGES,
    supportingText: null,
    qualityClass: null,
    rank: null
  }
}

const VISIBLE_FIELD_LABELS: ReadonlyMap<string, PaletteMatchedField> = new Map([
  [WORKTREE_PALETTE_NAME_FIELD_ID, 'displayName'],
  [WORKTREE_PALETTE_BRANCH_FIELD_ID, 'branch'],
  [WORKTREE_PALETTE_REPO_FIELD_ID, 'repo'],
  [WORKTREE_PALETTE_HOST_FIELD_ID, 'host']
])

function toSupportingText(match: PaletteDocumentMatch): PaletteSupportingText | null {
  const evidence = match.supportingEvidence[0]
  if (!evidence) {
    return null
  }
  const kind = evidence.kind as PaletteSupportingKind
  if (kind === 'comment') {
    const snippet = applyWorktreeCommentSnippet(evidence.text, evidence.ranges)
    return {
      labelKind: kind,
      text: snippet.text,
      matchRanges: snippet.ranges,
      accessibilityLabel: evidence.accessibilityLabel
    }
  }
  return {
    labelKind: kind,
    text: evidence.text,
    matchRanges: evidence.ranges,
    accessibilityLabel: evidence.accessibilityLabel
  }
}

export function toWorktreePaletteSearchResult(
  worktreeId: string,
  match: PaletteDocumentMatch,
  worktreeHostId?: Worktree['hostId']
): PaletteSearchResult {
  const supportingText = toSupportingText(match)
  const matchedFields: PaletteMatchedField[] = []
  for (const fieldId of match.rangesByField.keys()) {
    const label = VISIBLE_FIELD_LABELS.get(fieldId)
    if (label && !matchedFields.includes(label)) {
      matchedFields.push(label)
    }
  }
  if (supportingText) {
    matchedFields.push(supportingText.labelKind)
  }

  return {
    worktreeId,
    ...(worktreeHostId ? { worktreeHostId } : {}),
    matchedFields,
    displayNameRanges: match.rangesByField.get(WORKTREE_PALETTE_NAME_FIELD_ID) ?? NO_RANGES,
    branchRanges: match.rangesByField.get(WORKTREE_PALETTE_BRANCH_FIELD_ID) ?? NO_RANGES,
    repoRanges: match.rangesByField.get(WORKTREE_PALETTE_REPO_FIELD_ID) ?? NO_RANGES,
    hostRanges: match.rangesByField.get(WORKTREE_PALETTE_HOST_FIELD_ID) ?? NO_RANGES,
    supportingText,
    qualityClass: match.qualityClass,
    rank: match.rank
  }
}

export type WorktreePaletteSearchArgs = {
  worktrees: readonly Worktree[]
  query: string
  documents: ReadonlyMap<string, PaletteDocument>
  repoMap: ReadonlyMap<string, Repo>
  repoMapByHostIdentity?: ReadonlyMap<string, Repo>
  checksReviewByWorktree?: ReadonlyMap<Worktree, HostedReviewInfo | null>
}

/** Matches prepared documents; callers memoize `documents` across keystrokes. */
export function searchWorktreeDocuments(args: WorktreePaletteSearchArgs): PaletteSearchResult[] {
  const prepared = preparePaletteQuery(args.query)
  if (prepared.state === 'invalid') {
    return []
  }
  if (prepared.state === 'empty') {
    return args.worktrees.map((worktree) =>
      makeEmptyPaletteSearchResult(worktree.id, worktree.hostId)
    )
  }

  const taskSourceUrl = parseCmdJTaskSourceUrl(args.query.trim())
  const results: PaletteSearchResult[] = []
  for (const worktree of args.worktrees) {
    if (taskSourceUrl) {
      const match = matchWorktreePaletteTaskUrl({
        worktree,
        intent: taskSourceUrl,
        repo: resolvePaletteRepoForWorktree(worktree, args.repoMap, args.repoMapByHostIdentity),
        review: args.checksReviewByWorktree?.get(worktree)
      })
      if (match) {
        results.push(match)
      }
      continue
    }

    const document = args.documents.get(getWorktreeHostIdentity(worktree))
    if (!document) {
      continue
    }
    const match = matchPaletteDocument({
      document,
      tokens: prepared.tokens,
      normalizedQuery: prepared.normalized
    })
    if (match) {
      results.push(toWorktreePaletteSearchResult(worktree.id, match, worktree.hostId))
    }
  }
  return results
}

/** Convenience entry point that prepares documents inline. */
export function searchWorktrees(
  worktrees: readonly Worktree[],
  query: string,
  repoMap: ReadonlyMap<string, Repo>,
  sources: Omit<WorktreePaletteDocumentSources, 'repoMap'> = {}
): PaletteSearchResult[] {
  const documentSources: WorktreePaletteDocumentSources = { ...sources, repoMap }
  return searchWorktreeDocuments({
    worktrees,
    query,
    documents: buildWorktreePaletteDocuments(worktrees, documentSources),
    repoMap,
    repoMapByHostIdentity: sources.repoMapByHostIdentity,
    checksReviewByWorktree: sources.checksReviewByWorktree
  })
}

export type { IssueCacheEntry, PRCacheEntry }
