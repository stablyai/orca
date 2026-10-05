import { comparePaletteRankedItems } from '@/lib/cmd-j-section-leadership'
import { getPaletteWorktreeIdentity } from '@/lib/palette-repo-resolution'
import { encodePaletteIdentity } from '@/lib/palette-match/palette-ranking'
import type { WorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'
import type { BrowserPaletteSearchResult } from '@/lib/browser-palette-search'
import type { SimulatorPaletteSearchResult } from '@/lib/simulator-palette-search'
import type { WorkspaceTabPaletteSearchResult } from '@/lib/workspace-tab-palette-search'
import type {
  BrowserPaletteItem,
  OpenTabPaletteItem,
  SimulatorPaletteItem,
  WorkspaceTabPaletteItem,
  WorktreePaletteItem
} from './worktree-jump-palette-model'

/**
 * Resolves host-qualified worktree matches, dropping identities that no longer exist.
 * Keeps discovery order without a query and applies the common rank/activity ordering with one.
 */
export function buildWorktreePaletteItems({
  worktreeMatches,
  resolveWorktree,
  hasQuery
}: Pick<
  WorktreeJumpPaletteWorktrees,
  'worktreeMatches' | 'resolveWorktree' | 'hasQuery'
>): WorktreePaletteItem[] {
  const items = worktreeMatches
    .map((match) => {
      const worktree = resolveWorktree(match.worktreeId, match.worktreeHostId)
      return worktree
        ? {
            id: encodePaletteIdentity(['worktree', getPaletteWorktreeIdentity(worktree)]),
            type: 'worktree' as const,
            match,
            worktree
          }
        : null
    })
    .filter((item): item is WorktreePaletteItem => item !== null)
  if (!hasQuery) {
    return items
  }
  const orderByIdentity = new Map(
    items.map((item, index) => [getPaletteWorktreeIdentity(item.worktree), index])
  )
  return items.sort((left, right) =>
    comparePaletteRankedItems(
      {
        rank: left.match.rank,
        order: orderByIdentity.get(getPaletteWorktreeIdentity(left.worktree)) ?? 0,
        identity: left.id,
        activity: left.match.activity
      },
      {
        rank: right.match.rank,
        order: orderByIdentity.get(getPaletteWorktreeIdentity(right.worktree)) ?? 0,
        identity: right.id,
        activity: right.match.activity
      }
    )
  )
}

export function buildBrowserPaletteItems(
  results: readonly BrowserPaletteSearchResult[]
): BrowserPaletteItem[] {
  return results.map((result) => ({
    id: result.paletteIdentity,
    type: 'browser-page',
    result
  }))
}

export function buildSimulatorPaletteItems(
  results: readonly SimulatorPaletteSearchResult[]
): SimulatorPaletteItem[] {
  return results.map((result) => ({
    id: result.paletteIdentity,
    type: 'simulator-tab',
    result
  }))
}

export function buildWorkspaceTabPaletteItems(
  results: readonly WorkspaceTabPaletteSearchResult[]
): WorkspaceTabPaletteItem[] {
  return results.map((result) => ({
    id: result.paletteIdentity,
    type: 'workspace-tab',
    result
  }))
}

export function buildOpenTabPaletteItems({
  browserItems,
  simulatorItems,
  workspaceTabItems
}: {
  browserItems: readonly BrowserPaletteItem[]
  simulatorItems: readonly SimulatorPaletteItem[]
  workspaceTabItems: readonly WorkspaceTabPaletteItem[]
}): OpenTabPaletteItem[] {
  return [...browserItems, ...simulatorItems, ...workspaceTabItems].sort((left, right) =>
    comparePaletteRankedItems(
      {
        rank: left.result.rank,
        order: left.result.score,
        identity: left.id,
        activity: left.result.activity
      },
      {
        rank: right.result.rank,
        order: right.result.score,
        identity: right.id,
        activity: right.result.activity
      }
    )
  )
}
