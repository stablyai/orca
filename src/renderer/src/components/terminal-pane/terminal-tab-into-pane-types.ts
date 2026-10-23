import type { AppState } from '@/store'
import type { SetTerminalPaneTitleDetail, SplitTerminalPaneDetail } from '@/constants/terminal'
import type {
  TerminalLeafIntoTabRequest,
  TerminalLeafIntoTabResult
} from '../../../../shared/terminal-leaf-move'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { PaneSide } from '../../../../shared/workspace-layout/terminal-pane-tree'
import type { TerminalTabIntoPaneState } from './terminal-tab-into-pane-eligibility'

export type TerminalTabIntoPaneStore = TerminalTabIntoPaneState &
  Pick<
    AppState,
    | 'closeTab'
    | 'expandedPaneByTabId'
    | 'remountTerminalTabForRecovery'
    | 'setActiveTab'
    | 'setActiveTabType'
    | 'setTabLayout'
    | 'syncPaneMoveIntoTabPtyOwnership'
    | 'updateTabPtyId'
  >

/** Everything the move touches outside the store, so the ordering can be tested without a DOM. */
export type TerminalTabIntoPaneDeps = {
  getStore: () => TerminalTabIntoPaneStore
  /** Leaf ids of T's mounted panes; null when no TerminalPane is mounted for the tab. */
  mountedLeafIds: (tabId: string) => string[] | null
  dispatchSplit: (detail: SplitTerminalPaneDetail) => void
  dispatchToggleExpand: (tabId: string) => void
  dispatchPaneTitle: (detail: SetTerminalPaneTitleDetail) => void
  scheduleGraphSync: () => void
  resyncParkedWatchers: (worktreeId: string, targetTabId: string) => void
  /** Main's current session, for settling an IPC call whose answer never arrived. */
  readMainSession: () => Promise<{
    terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  } | null>
  moveLeafIntoTab: (request: TerminalLeafIntoTabRequest) => Promise<TerminalLeafIntoTabResult>
}

export type TerminalTabIntoPaneArgs = {
  sourceTabId: string
  targetTabId: string
  /** Defaults to the target tab's active leaf. */
  targetLeafId?: string | null
  side: PaneSide
}

/** `unknown`: main may have committed while this window did not (or could not) finish applying. */
export type TerminalTabIntoPaneOutcome = 'moved' | 'refused' | 'unknown'
