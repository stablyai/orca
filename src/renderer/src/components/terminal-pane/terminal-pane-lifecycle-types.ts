import type { IDisposable } from '@xterm/xterm'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { SetupSplitDirection } from '../../../../shared/worktree/launch-types'
import type { DirectSshPaneRetryAttemptId } from '@/store/slices/direct-ssh-terminal-recovery'
import type {
  PaneExternalDropHandler,
  PaneExternalDropResolver,
  PaneManager
} from '@/lib/pane-manager/pane-manager'
import type { EffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/detect-option-as-alt'
import type { PaneCwdMap } from './resolve-split-cwd'
import type { PaneProcessExit, PtyPaneStartup } from './pty-connection-types'
import type { PtyTransport } from './pty-transport'
import type { PtyTransportRecoveryState } from './pty-transport-types'
import type { ReplayingPanesRef } from './replay-guard'
import type { TerminalLinkActionRequester } from './terminal-link-action-request'
import type { TerminalLinkRoutingPreferenceRequester } from './terminal-url-link-hit-testing'
import type { SessionRestoredBannerReason } from './session-restored-banner-pane-state'

export type TerminalPaneStartup = Exclude<PtyPaneStartup, null>

export type TerminalPaneSetupSplit = {
  command: string
  env?: Record<string, string>
  direction: SetupSplitDirection
}

export type TerminalPaneIssueCommandSplit = {
  command: string
  env?: Record<string, string>
}

export type UseTerminalPaneLifecycleDeps = {
  tabId: string
  worktreeId: string
  cwd?: string
  startup?: TerminalPaneStartup | null
  /** Split pane runs the setup command so the main terminal stays interactive. */
  setupSplit?: TerminalPaneSetupSplit | null
  /** Split pane runs the repo's issue-automation command with the issue number interpolated. */
  issueCommandSplit?: TerminalPaneIssueCommandSplit | null
  isActive: boolean
  isVisible: boolean
  systemPrefersDark: boolean
  settings: GlobalSettings | null | undefined
  settingsRef: React.RefObject<GlobalSettings | null | undefined>
  requestOpenLinksInAppPreference: TerminalLinkRoutingPreferenceRequester
  requestTerminalLinkAction: TerminalLinkActionRequester
  /** Resolved Option-as-Alt: `'auto'` already mapped via the layout probe. */
  effectiveMacOptionAsAlt: EffectiveMacOptionAsAlt
  effectiveMacOptionAsAltRef: React.RefObject<EffectiveMacOptionAsAlt>
  initialLayoutRef: React.RefObject<TerminalLayoutSnapshot>
  managerRef: React.RefObject<PaneManager | null>
  getTabWideAgentHintLeafId: () => string | null
  containerRef: React.RefObject<HTMLDivElement | null>
  expandedStyleSnapshotRef: React.MutableRefObject<
    Map<HTMLElement, { display: string; flex: string }>
  >
  paneFontSizesRef: React.RefObject<Map<number, number>>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  /** Per-pane live cwd (from the OSC 7 handler). */
  paneCwdRef: React.RefObject<PaneCwdMap>
  paneMode2031Ref: React.RefObject<Map<number, boolean>>
  paneKittyKeyboardModesRef: React.RefObject<Map<number, TerminalKittyKeyboardModeTracker>>
  paneLastThemeModeRef: React.RefObject<Map<number, 'dark' | 'light'>>
  panePtyBindingsRef: React.RefObject<Map<number, IDisposable>>
  replayingPanesRef: ReplayingPanesRef
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
  onPtyExitRef: React.RefObject<(ptyId: string, exitCode?: number) => void>
  onAgentExitedRef: React.RefObject<(leafId: string) => void>
  onPtyErrorRef?: React.RefObject<(paneId: number, message: string) => void>
  onPtyErrorClearedRef?: React.RefObject<(paneId: number, message?: string) => void>
  onPaneProcessDied?: (processExit: PaneProcessExit) => void
  onPtyRecoveryStateRef?: React.RefObject<
    (paneId: number, state: PtyTransportRecoveryState | null) => void
  >
  clearTabPtyId: (tabId: string, ptyId: string) => void
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  isPtyShutdownPending: (ptyId: string) => boolean
  updateTabTitle: (tabId: string, title: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  updateTabPtyId: (
    tabId: string,
    ptyId: string,
    replacedPtyId?: string,
    directSshRetryAttemptId?: DirectSshPaneRetryAttemptId
  ) => void
  markWorktreeUnread: (worktreeId: string) => void
  markTerminalTabUnread: (tabId: string) => void
  markTerminalPaneUnread: (paneKey: string) => void
  clearWorktreeUnread: (worktreeId: string) => void
  clearTerminalTabUnread: (tabId: string) => void
  clearTerminalPaneUnread: (paneKey: string) => void
  onShowSessionRestoredBanner: (paneId: number, reason?: SessionRestoredBannerReason) => void
  dispatchNotification: (event: {
    source: 'terminal-bell' | 'agent-task-complete'
    terminalTitle?: string
    paneKey?: string
    agentStatusSnapshot?: ParsedAgentStatusPayload
    suppressOsNotification?: boolean
  }) => void
  setCacheTimerStartedAt: (key: string, ts: number | null) => void
  syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => void
  syncPanePtyLayoutBindingForLeaf?: (
    leafId: string,
    ptyId: string | null,
    sourcePaneId: number
  ) => void
  clearExitedPanePtyLayoutBinding: (paneId: number, exitedPtyId: string) => void
  clearExitedPanePtyLayoutBindingForLeaf?: (leafId: string, exitedPtyId: string) => void
  /** Settles the captured one-shot startup only after a pane owns a concrete PTY. */
  onStartupBound?: () => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  setTabCanExpandPane: (tabId: string, canExpand: boolean) => void
  setExpandedPane: (paneId: number | null) => void
  syncExpandedLayout: () => void
  persistLayoutSnapshot: () => void
  setPaneTitles: React.Dispatch<React.SetStateAction<Record<number, string>>>
  paneTitlesRef: React.RefObject<Record<number, string>>
  setRenamingPaneId: React.Dispatch<React.SetStateAction<number | null>>
  // Why: managerRef.getPanes() isn't reactive, so this dispatcher ticks effects when panes split/close.
  setPaneCount: React.Dispatch<React.SetStateAction<number>>
  // Why: same pane count != same geometry (drag-reorder moves without resizing).
  setPaneLayoutRevision: React.Dispatch<React.SetStateAction<number>>
  resolveExternalPaneDropTarget?: PaneExternalDropResolver
  onExternalPaneDrop?: PaneExternalDropHandler
}
