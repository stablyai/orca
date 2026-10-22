import { compareCmdJTranscriptRankedItems } from '@/lib/cmd-j-transcript-ranking'
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
  workspaceTabItems,
  transcriptOnlyItems = []
}: {
  browserItems: readonly BrowserPaletteItem[]
  simulatorItems: readonly SimulatorPaletteItem[]
  workspaceTabItems: readonly WorkspaceTabPaletteItem[]
  /** Original response ordinals remain attached through classification and deduplication. */
  transcriptOnlyItems?: readonly WorkspaceTabPaletteItem[]
}): OpenTabPaletteItem[] {
  return [...browserItems, ...simulatorItems, ...workspaceTabItems, ...transcriptOnlyItems].sort(
    (left, right) =>
      compareCmdJTranscriptRankedItems(
        {
          rank: left.result.rank,
          qualityClass: left.result.qualityClass,
          transcript: left.type === 'workspace-tab' ? left.transcript : undefined,
          order: left.result.score,
          identity: left.id,
          activity: left.result.activity
        },
        {
          rank: right.result.rank,
          qualityClass: right.result.qualityClass,
          transcript: right.type === 'workspace-tab' ? right.transcript : undefined,
          order: right.result.score,
          identity: right.id,
          activity: right.result.activity
        }
      )
  )
}
