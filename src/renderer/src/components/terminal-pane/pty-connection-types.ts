import type { PtyTransport } from './pty-transport'
import type { ReplayingPanesRef } from './replay-guard'
import type { RestoredViewportBlankingPanesRef } from './terminal-restored-viewport'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type { SetupSplitDirection, TuiAgent } from '../../../../shared/types'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'

export type PtyConnectionDeps = {
  tabId: string
  worktreeId: string
  cwd?: string
  startup?: {
    command: string
    /** Renderer-delivered startup input for callers that need xterm paste
     *  semantics before the submit Enter. */
    delivery?: 'terminal-paste'
    startupCommandDelivery?: StartupCommandDelivery
    env?: Record<string, string>
    envToDelete?: string[]
    launchConfig?: SleepingAgentLaunchConfig
    launchToken?: string
    launchAgent?: TuiAgent
    draftPrompt?: string
    /** Telemetry payload for `agent_started`. Forwarded to `pty:spawn`
     *  so main fires the event only after the spawn succeeds. */
    telemetry?: EventProps<'agent_started'>
    /** Initial prompt-start status for agents that lack native prompt hooks. */
    initialAgentStatus?: { agent: TuiAgent; prompt: string }
    /** Show the restored-session banner when this startup command mounts. */
    showSessionRestoredBanner?: boolean
    /** Initial startup may be paired with a setup split that changes its grid. */
    waitForSetupSplitDirection?: SetupSplitDirection
  } | null
  restoredLeafId?: string | null
  restoredPtyIdByLeafId?: Record<string, string>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  paneMode2031Ref: React.RefObject<Map<number, boolean>>
  /** Per-pane mirror of the kitty keyboard flags the pane's application
   *  negotiated. Fed from PTY output here; read by the keyboard policy. */
  paneKittyKeyboardModesRef: React.RefObject<Map<number, TerminalKittyKeyboardModeTracker>>

  paneLastThemeModeRef: React.RefObject<Map<number, TerminalColorSchemeMode>>
  replayingPanesRef: ReplayingPanesRef
  restoredViewportBlankingPanesRef?: RestoredViewportBlankingPanesRef
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
  onPtyExitRef: React.RefObject<(ptyId: string) => void>
  onAgentExitedRef: React.RefObject<(leafId: string) => void>
  onPtyErrorRef?: React.RefObject<(paneId: number, message: string) => void>
  clearTabPtyId: (tabId: string, ptyId: string) => void
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  updateTabTitle: (tabId: string, title: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  updateTabPtyId: (tabId: string, ptyId: string, replacedPtyId?: string) => void
  markWorktreeUnread: (worktreeId: string) => void
  markTerminalTabUnread: (tabId: string) => void
  markTerminalPaneUnread: (paneKey: string) => void
  clearWorktreeUnread: (worktreeId: string) => void
  clearTerminalTabUnread: (tabId: string) => void
  clearTerminalPaneUnread: (paneKey: string) => void
  onShowSessionRestoredBanner: (paneId: number) => void
  // Why: the renderer dispatches two notification sources — BEL from the PTY
  // byte stream and agent-task-complete on the working→idle title transition.
  // shared/types.ts keeps a wider NotificationEventSource union because the
  // main process can also emit `'test'` from the settings-pane button.
  dispatchNotification: (event: {
    source: 'terminal-bell' | 'agent-task-complete'
    terminalTitle?: string
    paneKey?: string
    agentStatusSnapshot?: AgentCompletionStatusSnapshot
    suppressOsNotification?: boolean
  }) => void
  setCacheTimerStartedAt: (key: string, ts: number | null) => void
  syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => void
  clearExitedPanePtyLayoutBinding: (paneId: number, exitedPtyId: string) => void
  /** Records a DECSET 2031 subscription answered from main's
   *  '2031-subscribe' fact, mirroring the xterm CSI handler's registry write
   *  (paneMode2031 + last replied theme) so later theme flips push CSI 997.
   *  The reply itself is sent by the fact handler — query authority stays
   *  with the view (model/view contract invariant 6). */
  recordPaneMode2031Subscription?: (paneId: number, repliedMode: 'dark' | 'light') => void
}
