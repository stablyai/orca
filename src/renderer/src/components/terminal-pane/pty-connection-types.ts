import type { WorkspaceAttentionSlice } from '@/store/slices/workspace-attention/workspace-attention-contract'
import type { NotificationWorkspaceOwner } from '../../../../shared/notification-source'
import type { PtyTransport, PtyTransportRecoveryState } from './pty-transport-types'
import type { SessionRestoredBannerReason } from './session-restored-banner-pane-state'
import type { ReplayingPanesRef } from './replay-guard'
import type { RestoredViewportBlankingPanesRef } from './terminal-restored-viewport'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { TerminalPanePlacement } from '../../../../shared/terminal-pane-placement'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import type { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { PtyPreconnectInputEntry } from './pty-preconnect-input-buffer'
import type { AgentPaneLaunchRequest } from '../../../../shared/agent-pane-launch-request'

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
  /** The agent launch the pane's own spawn starts, instead of `command`. */
  agentLaunch?: AgentPaneLaunchRequest
  /** Explicit CLI override for host-owned agent launches; omission uses host settings. */
  agentArgsOverride?: string | null
  draftPrompt?: string
  sessionOptions?: Record<string, SessionOptionValue>
  /** Main emits agent_started only after successful spawn. */
  telemetry?: EventProps<'agent_started'>
  /** Initial prompt-start status for agents that lack native prompt hooks. */
  initialAgentStatus?: { agent: TuiAgent; prompt: string }
  /** Show the restored-session banner when this startup command mounts. */
  showSessionRestoredBanner?: boolean
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
  /** Delays a fresh split's spawn without delaying its renderer pane. */
  cwdPromise?: Promise<string>
  placement?: TerminalPanePlacement
  /** Input handed off from a predecessor mount of the same deferred split. */
  preconnectInput?: readonly PtyPreconnectInputEntry[]
  /** Captures newly retained input for a remount-safe deferred split handoff. */
  onPreconnectInput?: (input: PtyPreconnectInputEntry) => void
  /** Releases a deferred split's detach fence when its initial spawn yields no PTY. */
  onDeferredCwdSpawnFailed?: () => void
  startup?: PtyPaneStartup
  /** The pane's previous PTY; main stops it before this connection's first fresh spawn. */
  replacesPtyId?: string
  restoredLeafId?: string | null
  restoredPtyIdByLeafId?: Record<string, string>
  /** Render-time park intent survives watcher disposal and is consumed once after layout replay. */
  mountFollowsTerminalPark: boolean
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  paneMode2031Ref: React.RefObject<Map<number, boolean>>
  /** Mirror xterm’s negotiated Kitty flags for keyboard policy. */
  paneKittyKeyboardModesRef: React.RefObject<Map<number, TerminalKittyKeyboardModeTracker>>

  paneLastThemeModeRef: React.RefObject<Map<number, TerminalColorSchemeMode>>
  replayingPanesRef: ReplayingPanesRef
  restoredViewportBlankingPanesRef?: RestoredViewportBlankingPanesRef
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
  /** Consume queued startup once this pane’s first fresh PTY binds; binding does not prove command delivery, which can precede it or fail with shell startup. */
  onQueuedStartupSpawned?: () => void
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  isPtyShutdownPending: (ptyId: string) => boolean
  updateTabTitle: (tabId: string, title: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  updateTabPtyId: (tabId: string, ptyId: string, replacedPtyId?: string) => void
  markTerminalBell: WorkspaceAttentionSlice['markTerminalBell']
  onShowSessionRestoredBanner: (paneId: number, reason?: SessionRestoredBannerReason) => void
  // Renderer notifications originate from BEL or completion; main also supports the settings test source.
  dispatchNotification: (event: {
    source: 'terminal-bell' | 'agent-task-complete'
    ptyId?: string | null
    workspaceOwner?: NotificationWorkspaceOwner
    terminalTitle?: string
    paneKey?: string
    agentStatusSnapshot?: AgentCompletionStatusSnapshot
  }) => void
  setCacheTimerStartedAt: (key: string, ts: number | null) => void
  syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => void
  /** Stable-leaf variant for async callbacks that may outlive a PaneManager instance. */
  syncPanePtyLayoutBindingForLeaf?: (
    leafId: string,
    ptyId: string | null,
    sourcePaneId: number
  ) => void
  clearExitedPanePtyLayoutBinding: (paneId: number, exitedPtyId: string) => void
  /** Stable-leaf variant for async exit callbacks that may outlive a PaneManager instance. */
  clearExitedPanePtyLayoutBindingForLeaf?: (leafId: string, exitedPtyId: string) => void
  /** Settles the captured one-shot startup only after this pane owns a concrete PTY. */
  onStartupBound?: () => void
  deferPtyInput?: (paneId: number, data: string, forward: (data: string) => void) => void
  /** Record main’s 2031 subscription and current theme for later flip pushes; subscription itself is silent (#9993). */
  recordPaneMode2031Subscription?: (paneId: number, subscribedMode: 'dark' | 'light') => void
}
