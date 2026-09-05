import { comparePaletteRankedItems } from '@/lib/cmd-j-section-leadership'
import { encodePaletteIdentity } from '@/lib/palette-match/palette-ranking'
import type { BrowserPaletteSearchResult } from '@/lib/browser-palette-search'
import type { SimulatorPaletteSearchResult } from '@/lib/simulator-palette-search'
import type { WorkspaceTabPaletteSearchResult } from '@/lib/workspace-tab-palette-search'
import type {
  BrowserPaletteItem,
  OpenTabPaletteItem,
  SimulatorPaletteItem,
  WorkspaceTabPaletteItem
} from './worktree-jump-palette-model'

export function buildBrowserPaletteItems(
  results: readonly BrowserPaletteSearchResult[]
): BrowserPaletteItem[] {
  return results.map((result) => ({
    id: encodePaletteIdentity([
      'browser-page',
      result.executionHostId ?? '',
      result.worktreeId,
      result.workspaceId,
      result.pageId
    ]),
    type: 'browser-page',
    result
  }))
}

export function buildSimulatorPaletteItems(
  results: readonly SimulatorPaletteSearchResult[]
): SimulatorPaletteItem[] {
  return results.map((result) => ({
    id: encodePaletteIdentity([
      'simulator-tab',
      result.executionHostId ?? '',
      result.worktreeId,
      result.tabId
    ]),
    type: 'simulator-tab',
    result
  }))
}

export function buildWorkspaceTabPaletteItems(
  results: readonly WorkspaceTabPaletteSearchResult[]
): WorkspaceTabPaletteItem[] {
  return results.map((result) => ({
    id: encodePaletteIdentity([
      'workspace-tab',
      result.executionHostId ?? '',
      result.worktreeId,
      result.tabId
    ]),
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
