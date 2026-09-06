import type { ClosedTerminalTabTombstonesByTabId } from '../../../../shared/closed-terminal-tab-tombstones'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SetupSplitDirection } from '../../../../shared/worktree/launch-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { AgentStartedTelemetry } from '../../lib/worktree-startup-payload'
import type {
  DirectSshLivePtyBinding,
  DirectSshPaneRetryAttempt,
  DirectSshPaneRetryHistory
} from '../slices/direct-ssh-terminal-recovery'
import type { NativeChatLaunchDraft, NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
import type { HostSessionSlices } from '@/lib/workspace-session-host-split'
import type { AutomaticAgentResumeClaim, CodexRestartNotice } from './terminal-contracts'
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TerminalActions } from './terminal-actions'

export type TerminalState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  activeTabId: string | null
  /** Per-worktree focus survives workspace switches independently of the global active tab. */
  activeTabIdByWorktree: Record<string, string | null>
  ptyIdsByTabId: Record<string, string[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  unreadTerminalTabs: Record<string, true>
  unreadTerminalPanes: Record<string, true>
  unreadAgentCompletionPanes: Record<string, true>
  /** Scoped exit suppression and reference-counted shutdown ownership prevent teardown races. */
  suppressedPtyExitIds: Record<string, true>
  pendingPtyShutdownIds: Record<string, number>
  pendingCodexPaneRestartIds: Record<string, true>
  codexRestartNoticeByPtyId: Record<string, CodexRestartNotice>
  directSshPaneRetryByTabId: Record<string, DirectSshPaneRetryAttempt>
  directSshLivePtyBindingByTabId: Record<string, DirectSshLivePtyBinding>
  directSshPaneRetryHistoryByTabId: Record<string, DirectSshPaneRetryHistory>
  expandedPaneByTabId: Record<string, boolean>
  canExpandPaneByTabId: Record<string, boolean>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
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
  pendingSetupSplitByTabId: Record<
    string,
    {
      command: string
      env?: Record<string, string>
      direction: SetupSplitDirection
    }
  >
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
  /**
   * Worktree-keyed session rows belonging to hosts that co-publish a workspace id with the host
   * that owns it here. Never read by the UI: it is the carrier that lets a write for the owning
   * host round-trip the other hosts' partitions instead of erasing them.
   */
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
  /**
   * Tabs whose PTY vanished without positive evidence of process death.
   *
   * This is session-scoped (never persisted) and protects a tab from the
   * orphan sweep while its execution host is unavailable. A replacement PTY
   * or an explicit close settles the marker.
   */
  unverifiedPtyLossTabIds: Record<string, true>
  /**
   * PTY ids a reachable relay disowned — no relay will hand them back.
   *
   * Session-scoped: the counterpart to the marker above, and the only signal strong enough to let a
   * reconnect retire a binding and respawn the pane. Short of `exited`, because a restarted relay
   * disowns ids it never minted. Settled when the id is bound again
   * (see terminal-disowned-pty-sources.ts).
   */
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
export type TerminalSlice = TerminalState & TerminalActions

export type TerminalStoreSet = Parameters<StateCreator<AppState, [], [], AppState>>[0]
export type TerminalStoreGet = Parameters<StateCreator<AppState, [], [], AppState>>[1]
