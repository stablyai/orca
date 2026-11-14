import type { HttpLinkRoutingPreferenceRequester as TerminalLinkRoutingPreferenceRequester } from '@/lib/browser/navigation/http-link-destinations'
import type { WorkspaceAttentionSlice } from '@/store/slices/workspace-attention/workspace-attention-contract'
import type { NotificationWorkspaceOwner } from '../../../../../shared/notification-source'
import type { PanePtyBinding } from '../pty-connection/pane-pty-binding'
import type { IDisposable } from '@xterm/xterm'
import type { ParsedAgentStatusPayload } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalKittyKeyboardModeTracker } from '../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { TerminalLayoutSnapshot } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type {
  PaneExternalDropHandler,
  PaneExternalDropResolver
} from '@/lib/pane-manager/pane-manager-types'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { EffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/detect-option-as-alt'
import type { PaneCwdMap } from '../layout/split/resolve-split-cwd'
import type { PaneProcessExit } from '../process-exit/pane-process-exit'
import type { PtyPaneStartup } from '../pty-connection/startup/pty-pane-startup'
import type { PtyTransport, PtyTransportRecoveryState } from '../pty-transport/pty-transport-types'
import type { ReplayingPanesRef } from '../snapshots/replay-guard'
import type { TerminalLinkActionRequester } from '../links/terminal-link-action-request'

import type { SessionRestoredBannerReason } from '../session-restore/session-restored-banner-pane-state'
import type { DetachTerminalPaneToNewTab } from '../layout/detach/terminal-pane-tab-detach'

export type TerminalPaneStartup = Exclude<PtyPaneStartup, null>

export type TerminalPaneIssueCommandSplit = {
  command: string
  env?: Record<string, string>
}

export type UseTerminalPaneLifecycleDeps = {
  tabId: string
  worktreeId: string
  cwd?: string
  startup?: TerminalPaneStartup | null
  /** Split pane runs the repo's issue-automation command with the issue number interpolated. */
  issueCommandSplit?: TerminalPaneIssueCommandSplit | null
  consumeTabIssueCommandSplit: (tabId: string) => void
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
  clearedScrollbackLeafIdsRef?: React.RefObject<Set<string>>
  managerRef: React.RefObject<PaneManager | null>
  getTabWideAgentHintLeafId: () => string | null
  containerRef: React.RefObject<HTMLDivElement | null>
  expandedStyleSnapshotRef: React.MutableRefObject<
    Map<HTMLElement, { display: string; flex: string }>
  >
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  /** Per-pane live cwd (from the OSC 7 handler). */
  paneCwdRef: React.RefObject<PaneCwdMap>
  paneMode2031Ref: React.RefObject<Map<number, boolean>>
  paneKittyKeyboardModesRef: React.RefObject<Map<number, TerminalKittyKeyboardModeTracker>>
  paneLastThemeModeRef: React.RefObject<Map<number, 'dark' | 'light'>>
  panePtyBindingsRef: React.RefObject<
    Map<number, IDisposable & Partial<Pick<PanePtyBinding, 'getOwnerContext'>>>
  >
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
  updateTabPtyId: (tabId: string, ptyId: string, replacedPtyId?: string) => void
  markTerminalBell: WorkspaceAttentionSlice['markTerminalBell']
  onShowSessionRestoredBanner: (paneId: number, reason?: SessionRestoredBannerReason) => void
  dispatchNotification: (event: {
    source: 'terminal-bell' | 'agent-task-complete'
    ptyId?: string | null
    workspaceOwner?: NotificationWorkspaceOwner
    terminalTitle?: string
    paneKey?: string
    agentStatusSnapshot?: ParsedAgentStatusPayload
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
  /** Re-renders mobile lock overlays for fit/driver state that arrived before a pane bound its PTY. */
  refreshMobileOverlays?: () => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  setTabCanExpandPane: (tabId: string, canExpand: boolean) => void
  setExpandedPane: (paneId: number | null) => void
  syncExpandedLayout: () => void
  persistLayoutSnapshot: () => void
  showPaneTitle: (paneId: number, title: string | null) => void
  setPaneTitles: React.Dispatch<React.SetStateAction<Record<number, string>>>
  paneTitlesRef: React.RefObject<Record<number, string>>
  setRenamingPaneId: React.Dispatch<React.SetStateAction<number | null>>
  // Why: managerRef.getPanes() isn't reactive, so this dispatcher ticks effects when panes split/close.
  setPaneCount: React.Dispatch<React.SetStateAction<number>>
  // Why: same pane count != same geometry (drag-reorder moves without resizing).
  setPaneLayoutRevision: React.Dispatch<React.SetStateAction<number>>
  resolveExternalPaneDropTarget?: PaneExternalDropResolver
  onExternalPaneDrop?: PaneExternalDropHandler
  detachPaneToNewTab?: DetachTerminalPaneToNewTab
}

export type MountedTerminalPaneLifecycleDeps = UseTerminalPaneLifecycleDeps & {
  mountedManager: PaneManager | null
}
