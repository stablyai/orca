import type { BrowserPaletteSearchResult } from '@/lib/browser-palette-search'
import type { PaletteSearchResult } from '@/lib/worktree-palette-search'
import type { SimulatorPaletteSearchResult } from '@/lib/simulator-palette-search'
import type { WorkspaceTabPaletteSearchResult } from '@/lib/workspace-tab-palette-search'
import type {
  CmdJActionResult,
  CmdJRankedMiddleResult,
  CmdJSettingsResult
} from '@/components/cmd-j/palette-results'
import type {
  CmdJProjectSearchResult,
  CmdJRankedProjectSearchResult
} from '@/components/cmd-j/palette-project-results'
import type { RecentWorkspaceTabRow } from '@/lib/recent-workspace-tab-rows'
import type { Worktree } from '../../../shared/worktree/types'
import { CREATE_WORKSPACE_QUICK_ACTION_ID } from '@/components/cmd-j/quick-actions'
import type { CREATE_WORKTREE_ITEM_ID } from '@/lib/worktree-palette-create-action'

export type WorktreePaletteItem = {
  id: string
  type: 'worktree'
  match: PaletteSearchResult
  worktree: Worktree
}

export type BrowserPaletteItem = {
  id: string
  type: 'browser-page'
  result: BrowserPaletteSearchResult
}

export type SimulatorPaletteItem = {
  id: string
  type: 'simulator-tab'
  result: SimulatorPaletteSearchResult
}

export type WorkspaceTabPaletteItem = {
  id: string
  type: 'workspace-tab'
  result: WorkspaceTabPaletteSearchResult
}

export type SettingsPaletteItem = {
  id: string
  type: 'settings'
  result: CmdJSettingsResult & Pick<CmdJRankedMiddleResult, 'qualityClass'>
}

export type QuickActionPaletteItem = {
  id: string
  type: 'quick-action'
  result: CmdJActionResult & Pick<CmdJRankedMiddleResult, 'qualityClass'>
}

export type ProjectTargetPaletteItem = {
  id: string
  type: 'project-target'
  result: CmdJProjectSearchResult & Pick<CmdJRankedProjectSearchResult, 'qualityClass'>
}

export type SectionHeader = { id: string; type: 'section-header'; label: string }
export type HintRow = {
  id: string
  type: 'hint'
  label: string
  onSeeMore?: () => void
}
export type CreateWorktreePaletteItem = {
  id: typeof CREATE_WORKTREE_ITEM_ID
  type: 'create-worktree'
}

export type PaletteItem =
  | WorktreePaletteItem
  | ProjectTargetPaletteItem
  | SettingsPaletteItem
  | QuickActionPaletteItem
  | BrowserPaletteItem
  | SimulatorPaletteItem
  | WorkspaceTabPaletteItem

export type PaletteListEntry = PaletteItem | CreateWorktreePaletteItem | SectionHeader | HintRow
export type OpenTabPaletteItem = BrowserPaletteItem | SimulatorPaletteItem | WorkspaceTabPaletteItem

export type OpenTabRecentRow = {
  item: OpenTabPaletteItem
  /** Stable per-occurrence key; persisted tab ids can collide across hosts/snapshots. */
  occurrenceId: string
  worktree: Worktree
  row: RecentWorkspaceTabRow
}

export const CREATE_WORKSPACE_QUICK_ACTION_ITEM_ID = `quick-action:${CREATE_WORKSPACE_QUICK_ACTION_ID}`

// Keep the status selectors alive through the command dialog's close animation so
// rows do not disappear halfway through the fade.
export const PALETTE_CLOSE_LINGER_MS = 300
/** Backwards-compatible name for selectors that share the close-animation window. */
export const PALETTE_STATUS_INPUTS_LINGER_MS = PALETTE_CLOSE_LINGER_MS
export const DIGIT_INDEX_ACTION_ID = 'workspace.selectByIndex' as const
// Why: the chord only binds keys 1–9, so expanded rows past the ninth are unaddressable.
export const DIGIT_INDEX_ADDRESSABLE_ROWS = 9
export const EMPTY_QUERY_RECENT_TAB_CAP = 6
export const EMPTY_QUERY_ROW_BUDGET = 10
export const EMPTY_QUERY_WORKTREE_CAP = 5
export const EMPTY_RECENT_TAB_ORDER: readonly string[] = []
export const EMPTY_SORTED_WORKTREES: Worktree[] = []
export const CONTINUED_SECTION_HEADER_ID_SUFFIX = '__continued'

export function appendPaletteListEntries(
  target: PaletteListEntry[],
  source: readonly PaletteItem[]
): void {
  for (const entry of source) {
    target.push(entry)
  }
}
