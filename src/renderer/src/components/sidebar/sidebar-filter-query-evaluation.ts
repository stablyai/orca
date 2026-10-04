import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { PaletteDocument } from '@/lib/palette-match/palette-document'
import { getPaletteWorktreeIdentity } from '@/lib/palette-repo-resolution'
import { buildWorktreePaletteDocuments } from '@/lib/worktree-palette-document'
import { isWorktreePaletteQueryTooLarge } from '@/lib/worktree-palette-query-bounds'
import { searchWorktreeDocuments } from '@/lib/worktree-palette-search'
import {
  getWorkspaceFilterAnyText,
  getWorkspaceFilterIdentityText,
  parseWorkspaceFilterQuery,
  type ParsedWorkspaceFilterQuery
} from './workspace-filter-query'
import type { WorkspaceFilterTextVerdicts } from './workspace-filter-query-match'

/**
 * Everything the visibility pipeline needs to apply one typed query: the parsed
 * grammar, the palette's free-text verdicts (keyed by host identity), and the
 * label maps that turn ids into what the user sees on the row.
 */
export type SidebarFilterQueryEvaluation = {
  parsed: ParsedWorkspaceFilterQuery
  verdicts: WorkspaceFilterTextVerdicts
  hostLabelById: ReadonlyMap<string, string>
  statusLabelById: ReadonlyMap<string, string>
}

export type SidebarFilterQueryDocumentIndex = {
  /** Name, branch, project and host only: what the row prints. */
  identity: ReadonlyMap<string, PaletteDocument>
  /** Every palette field, for `any:`. */
  wide: ReadonlyMap<string, PaletteDocument>
}

function buildHostLabelByWorktreeId(
  worktrees: readonly Worktree[],
  repoMap: ReadonlyMap<string, Repo>,
  hostLabelById: ReadonlyMap<string, string>,
  resolveHostId: (worktree: Worktree, repo: Repo | undefined) => ExecutionHostId
): Map<string, string> {
  const labels = new Map<string, string>()
  for (const worktree of worktrees) {
    const label = hostLabelById.get(resolveHostId(worktree, repoMap.get(worktree.repoId)))
    if (label) {
      labels.set(getPaletteWorktreeIdentity(worktree), label)
    }
  }
  return labels
}

export function buildSidebarFilterQueryDocumentIndex(args: {
  worktrees: readonly Worktree[]
  repoMap: ReadonlyMap<string, Repo>
  hostLabelById: ReadonlyMap<string, string>
  resolveHostId: (worktree: Worktree, repo: Repo | undefined) => ExecutionHostId
}): SidebarFilterQueryDocumentIndex {
  const live = args.worktrees.filter((worktree) => !worktree.isArchived)
  const hostLabelByWorktreeId = buildHostLabelByWorktreeId(
    live,
    args.repoMap,
    args.hostLabelById,
    args.resolveHostId
  )
  return {
    // Why `board`: the identity search must only accept a row for text printed
    // on it, otherwise a bare word silently matches a hidden review title.
    identity: buildWorktreePaletteDocuments(live, {
      repoMap: args.repoMap,
      hostLabelByWorktreeId,
      evidencePolicy: 'board'
    }),
    wide: buildWorktreePaletteDocuments(live, {
      repoMap: args.repoMap,
      hostLabelByWorktreeId,
      evidencePolicy: 'palette'
    })
  }
}

function matchedIdentities(
  worktrees: readonly Worktree[],
  query: string,
  documents: ReadonlyMap<string, PaletteDocument>,
  repoMap: ReadonlyMap<string, Repo>
): ReadonlySet<string> | null {
  if (!query.trim() || isWorktreePaletteQueryTooLarge(query)) {
    return null
  }
  const matched = new Set<string>()
  for (const result of searchWorktreeDocuments({
    worktrees,
    query,
    documents,
    repoMap
  })) {
    if (result.matchedFields.length) {
      matched.add(composeWorktreeHostIdentity(result.worktreeHostId, result.worktreeId))
    }
  }
  return matched
}

export function evaluateSidebarFilterQueryText(args: {
  parsed: ParsedWorkspaceFilterQuery
  worktrees: readonly Worktree[]
  repoMap: ReadonlyMap<string, Repo>
  index: SidebarFilterQueryDocumentIndex
}): WorkspaceFilterTextVerdicts {
  return {
    identityMatched: matchedIdentities(
      args.worktrees,
      getWorkspaceFilterIdentityText(args.parsed),
      args.index.identity,
      args.repoMap
    ),
    anyMatched: matchedIdentities(
      args.worktrees,
      getWorkspaceFilterAnyText(args.parsed),
      args.index.wide,
      args.repoMap
    )
  }
}

/** One-shot evaluation for callers outside React (Cmd+1-9, reveal, jump checks). */
export function buildSidebarFilterQueryEvaluation(args: {
  query: string
  worktrees: readonly Worktree[]
  repoMap: ReadonlyMap<string, Repo>
  hostLabelById: ReadonlyMap<string, string>
  statusLabelById: ReadonlyMap<string, string>
  resolveHostId: (worktree: Worktree, repo: Repo | undefined) => ExecutionHostId
}): SidebarFilterQueryEvaluation | null {
  const parsed = parseWorkspaceFilterQuery(args.query)
  if (!parsed.isActive) {
    return null
  }
  const index = buildSidebarFilterQueryDocumentIndex(args)
  return {
    parsed,
    verdicts: evaluateSidebarFilterQueryText({
      parsed,
      worktrees: args.worktrees,
      repoMap: args.repoMap,
      index
    }),
    hostLabelById: args.hostLabelById,
    statusLabelById: args.statusLabelById
  }
}
