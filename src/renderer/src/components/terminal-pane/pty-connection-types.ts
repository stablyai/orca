import type { PtyTransport } from './pty-transport'
import type { SessionRestoredBannerReason } from './session-restored-banner-pane-state'
import type { ReplayingPanesRef } from './replay-guard'
import type { RestoredViewportBlankingPanesRef } from './terminal-restored-viewport'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SetupSplitDirection } from '../../../../shared/worktree/launch-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { PtyTransportRecoveryState } from './pty-transport-types'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { DirectSshPaneRetryAttemptId } from '@/store/slices/direct-ssh-terminal-recovery'

export type PtyPaneStartup = {
  command: string
  /** Renderer-delivered startup input for callers that need xterm paste
   *  semantics before the submit Enter. */
  delivery?: 'terminal-paste'
  startupCommandDelivery?: StartupCommandDelivery
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  /** Explicit CLI override for host-owned agent launches; omission uses host settings. */
  agentArgsOverride?: string | null
  draftPrompt?: string
  sessionOptions?: Record<string, SessionOptionValue>
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

export type PaneProcessExit = {
  paneId: number
  exitCode: number
  reason: 'git-bash-console-capacity' | 'process-failed'
  startup: PtyPaneStartup
}

export type PtyConnectionDeps = {
  tabId: string
  worktreeId: string
  cwd?: string
  startup?: PtyPaneStartup
  restoredLeafId?: string | null
  restoredPtyIdByLeafId?: Record<string, string>
  /** Park intent sampled at render time, before the host disposes the tab's
   *  watchers; consumed once the restored layout has been replayed. */
  mountFollowsTerminalPark: boolean
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
  onPaneProcessDied?: (processExit: PaneProcessExit) => void
  onPtyRecoveryStateRef?: React.RefObject<
    (paneId: number, state: PtyTransportRecoveryState | null) => void
  >
  clearTabPtyId: (tabId: string, ptyId: string) => void
  /** Set only on the pane carrying the tab's queued startup command; called once its own fresh
   *  spawn exists, which is the first moment a live shell exists to receive it. Not proof of
   *  delivery: Windows runs an argv-embedded command before this, and a POSIX shell can die
   *  before the shell-ready write. */
  onQueuedStartupSpawned?: () => void
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
  deferPtyInput?: (paneId: number, data: string, forward: (data: string) => void) => void
  /** Records a DECSET 2031 subscription seen through main's '2031-subscribe'
   *  fact (paneMode2031 + the mode at subscribe time) so later theme flips push
   *  CSI 997. Subscribing itself is silent — see #9993. */
  recordPaneMode2031Subscription?: (paneId: number, subscribedMode: 'dark' | 'light') => void
}
