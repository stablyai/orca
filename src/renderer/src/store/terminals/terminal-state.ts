import type { ClosedTerminalTabTombstonesByTabId } from '../../../../shared/closed-terminal-tab-tombstones'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type {
  PaneResumeOutcome,
  PaneStartStatus
} from '../../../../shared/workspace-layout/workspace-layout-published'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { AgentStartedTelemetry } from '../../lib/worktree-startup-payload'
import type { NativeChatLaunchDraft, NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
import type { HostSessionSlices } from '@/lib/workspace-session-host-split'
import type {
  AccountRestartAgent,
  AutomaticAgentResumeClaim,
  CodexRestartNotice
} from './terminal-contracts'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TerminalActions } from './terminal-actions'
import type { AgentPaneLaunchRequest } from '../../../../shared/agent-pane-launch-request'
import type { PairedTerminalTabCloseIntentSlice } from './paired-terminal-tab-close-intent-actions'

export type TerminalState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  activeTabId: string | null
  /** Per-worktree focus survives workspace switches independently of the global active tab. */
  activeTabIdByWorktree: Record<string, string | null>
  ptyIdsByTabId: Record<string, string[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  /** Scoped exit suppression and reference-counted shutdown ownership prevent teardown races. */
  suppressedPtyExitIds: Record<string, true>
  pendingPtyShutdownIds: Record<string, number>
  /** Account-switch restarts awaiting execution, keyed by the PTY they replace. */
  pendingPaneAccountRestarts: Record<string, AccountRestartAgent>
  codexRestartNoticeByPtyId: Record<string, CodexRestartNotice>
  expandedPaneByTabId: Record<string, boolean>
  canExpandPaneByTabId: Record<string, boolean>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  /** Unsaved main-owned start markers; panes with entries must not start their own terminals. */
  terminalPaneStartsByPaneKey: Record<string, TerminalPaneStart>
  /** Unsaved main-published agent resume outcome scoped to the named terminal. */
  terminalPaneResumeOutcomesByPaneKey: Record<string, TerminalPaneResumeOutcome>
  /** Local-only parked scrollback by tab/leaf; never upload, read via resolveLeafScrollbackBuffers (WorkspaceSessionState.localOnlyScrollbackByTabId). */
  localOnlyScrollbackByTabId: Record<string, Record<string, string>>
  recentQuickCommandIdByGroup: Record<string, string>
  /** Runtime-only claim bridging startup payload consumption until terminal hooks mount. */
  automaticAgentResumeClaimsByTabId: Record<string, AutomaticAgentResumeClaim>
  nativeChatLaunchPromptByTabId: Record<string, NativeChatLaunchPrompt>
  nativeChatLaunchDraftByTabId: Record<string, NativeChatLaunchDraft>
  pendingStartupByTabId: Record<
    string,
    {
      command: string
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
      agentArgsOverride?: string | null
      draftPrompt?: string
      sessionOptions?: Record<string, SessionOptionValue>
      initialAgentStatus?: {
        agent: TuiAgent
        prompt: string
      }
      showSessionRestoredBanner?: boolean
      telemetry?: AgentStartedTelemetry
    }
  >
  pendingInitialCwdByTabId: Record<string, string>
  pendingIssueCommandSplitByTabId: Record<
    string,
    {
      command: string
      env?: Record<string, string>
    }
  >
  tabBarOrderByWorktree: Record<string, string[]>
  /** False until global reconnect publishes every deferred wake hint. */
  workspaceSessionReady: boolean
  /** True after main ownership restoration, renderer PTY adoption, and structured-tab projection settle. */
  terminalStartupRestorationReady: boolean
  restoredRuntimeHostIdByWorkspaceSessionKey: Record<string, ExecutionHostId>
  /** Carry non-owning hosts’ same-ID session partitions through owner writes without erasing them; never rendered directly. */
  contestedHostWorkspaceSessions: HostSessionSlices
  /** Partition each restored session key was read from, so a write returns its rows there. */
  contestedPrimaryHostBySessionKey: Record<string, ExecutionHostId>
  defaultTerminalTabsAppliedByWorktreeId: Record<string, true>
  closedTerminalTabTombstonesByTabId: ClosedTerminalTabTombstonesByTabId
  hydrationSucceeded: boolean
  pendingReconnectWorktreeIds: string[]
  pendingReconnectTabByWorktree: Record<string, string[]>
  /** Prior daemon/relay identities are wake hints; they are not proof of current liveness. */
  pendingReconnectPtyIdByTabId: Record<string, string>
  /** Retained across relay disconnect after tab.ptyId is cleared so persistence can reattach. */
  lastKnownRelayPtyIdByTabId: Record<string, string>
  /** Session-only protection after unverifiable PTY loss; replacement bind or explicit close settles it, not host unavailability. */
  unverifiedPtyLossTabIds: Record<string, true>
  /** Session-only reachable-relay disown evidence permits binding retirement/respawn but is weaker than exited; rebind settles it (terminal-disowned-pty-sources.ts). */
  disownedPtyIds: Record<string, true>
  /** Reattach snapshots are consumed once by the pane that receives the replacement PTY. */
  pendingSnapshotByPtyId: Record<
    string,
    {
      snapshot: string
      cols?: number
      rows?: number
      isAlternateScreen?: boolean
    }
  >
  pendingColdRestoreByPtyId: Record<
    string,
    {
      scrollback: string
      cwd: string
    }
  >
  cacheTimerByKey: Record<string, number | null>
  lastTerminalInputAtByPaneKey: Record<string, number>
  deferredSshReconnectTargets: string[]
  deferredSshSessionIdsByTabId: Record<string, string>
}
export type TerminalSlice = TerminalState & TerminalActions & PairedTerminalTabCloseIntentSlice

export type TerminalStoreSet = Parameters<StateCreator<AppState, [], [], AppState>>[0]
export type TerminalStoreGet = Parameters<StateCreator<AppState, [], [], AppState>>[1]

export type TerminalPaneStart = { status: PaneStartStatus; reason?: string }
/** `ptyGeneration` tells two starts under one terminal id apart (a daemon session id is reused). */
export type TerminalPaneResumeOutcome = {
  ptyId: string
  ptyGeneration?: number
  outcome: PaneResumeOutcome
}
