import type { Tab } from '../../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { SetupSplitDirection } from '../../../../shared/worktree/launch-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import type { DirectSshAuthority } from '../../../../shared/ssh-types'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import type { AgentStartedTelemetry } from '../../lib/worktree-startup-payload'
import type { AiVaultSessionTitle } from '../../../../shared/ai-vault-session-title'
import type {
  GeneratedTabTitleUpdate,
  TerminalTabTitleUpdate
} from '../slices/terminal-tab-title-batch'
import type {
  DirectSshPaneRetryAttemptId,
  DirectSshPaneRetryResult
} from '../slices/direct-ssh-terminal-recovery'
import type { NativeChatLaunchDraft, NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
import type { AgentStatusWorktreeShutdownReason } from '../slices/agent-status'
import type {
  TerminalTabCloseReason,
  TerminalTabRetirementPlan
} from '../slices/terminal-tab-retirement'
import type {
  AutomaticAgentResumeClaim,
  CodexRestartNotice,
  HydrateWorkspaceSessionOptions,
  ReconnectPersistedTerminalsOptions
} from './terminal-contracts'

export type TerminalActions = {
  setRecentQuickCommandForGroup: (groupId: string, quickCommandId: string) => void
  claimAutomaticAgentResume: (tabId: string, claim: AutomaticAgentResumeClaim) => void
  seedNativeChatLaunchPrompt: (prompt: NativeChatLaunchPrompt) => void
  markNativeChatLaunchPromptFailed: (tabId: string) => void
  clearNativeChatLaunchPrompt: (tabId: string) => void
  seedNativeChatLaunchDraft: (draft: NativeChatLaunchDraft) => void
  markNativeChatLaunchDraftAdopted: (tabId: string) => void
  resolveNativeChatLaunchDraft: (
    tabId: string,
    resolution: Pick<NativeChatLaunchDraft, 'createdAt' | 'text'>
  ) => void
  clearNativeChatLaunchDraft: (tabId: string) => void
  markDefaultTerminalTabsApplied: (worktreeId: string) => void
  setHydrationSucceeded: (value: boolean) => void
  consumePendingSnapshot: (ptyId: string) => {
    snapshot: string
    cols?: number
    rows?: number
    isAlternateScreen?: boolean
  } | null
  consumePendingColdRestore: (ptyId: string) => {
    scrollback: string
    cwd: string
  } | null
  /** Atomically publishes runtime and unified tab ownership, layout, ordering, and focus. */
  createTab: (
    worktreeId: string,
    targetGroupId?: string,
    shellOverride?: string,
    options?: {
      pendingActivationSpawn?: boolean
      initialPtyId?: string
      activate?: boolean
      recordInteraction?: boolean
      id?: string
      launchAgent?: TuiAgent
      quickCommandLabel?: string | null
      viewMode?: Tab['viewMode']
      startupCwd?: string
      forceHostRuntime?: boolean
    }
  ) => TerminalTab
  openNewTerminalTabInActiveWorkspace: (groupId: string) => Promise<void>
  /** Synchronous retirement: provider teardown starts before state removal but is never awaited. */
  closeTab: (
    tabId: string,
    opts?: {
      recordInteraction?: boolean
      reason?: TerminalTabCloseReason
      captureRecentlyClosed?: boolean
      remoteCloseOwnedByHost?: boolean
      localPtyTeardownOwnedExternally?: boolean
      precomputedRetirementPlan?: TerminalTabRetirementPlan
    }
  ) => void
  reorderTabs: (worktreeId: string, tabIds: string[]) => void
  setTabBarOrder: (worktreeId: string, order: string[]) => void
  setActiveTab: (tabId: string) => void
  setActiveTabForWorktree: (worktreeId: string, tabId: string) => void
  /** Resolve the canonical legacy terminal-tab owner key for renderer lifecycle guards. */
  getTerminalTabOwnerWorktreeId?: (tabId: string) => string | null
  updateTabTitle: (tabId: string, title: string) => void
  updateTabTitles: (updates: readonly TerminalTabTitleUpdate[]) => void
  setAiVaultTabTitle: (tabId: string, aiVaultTitle: AiVaultSessionTitle | null) => void
  setGeneratedTabTitleFromAgentPrompt: (
    paneKey: string,
    prompt: string,
    options?: {
      replaceExistingGeneratedTitle?: boolean
    }
  ) => void
  setGeneratedTabTitlesFromAgentPrompts: (updates: readonly GeneratedTabTitleUpdate[]) => void
  clearTabLaunchAgent: (tabId: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  markTerminalTabUnread: (tabId: string) => void
  markTerminalPaneUnread: (paneKey: string) => void
  markAgentCompletionPaneUnread: (paneKey: string) => void
  clearTerminalTabUnread: (tabId: string) => void
  clearTerminalPaneUnread: (paneKey: string) => void
  setTabCustomTitle: (
    tabId: string,
    title: string | null,
    opts?: {
      recordInteraction?: boolean
    }
  ) => void
  setTabColor: (tabId: string, color: string | null) => void
  /** Binds only live tabs and migrates replacement identity state before publishing ownership. */
  updateTabPtyId: (
    tabId: string,
    ptyId: string,
    replacedPtyId?: string,
    directSshRetryAttemptId?: DirectSshPaneRetryAttemptId
  ) => void
  /** Reconciles exact exits; bulk clear intentionally retains relay-grace identity. */
  clearTabPtyId: (tabId: string, ptyId?: string) => void
  clearDirectSshTargetPtyBindings: (targetId: string) => number
  invalidateStaleDirectSshTargetPtyBindings: (authority: DirectSshAuthority) => number
  retryDirectSshTargetPanes: (authority: DirectSshAuthority, now?: number) => number
  settleDirectSshPaneRetry: (result: DirectSshPaneRetryResult, now?: number) => void
  /** Awaited verified shutdown; unlike closeTab, physical teardown gates the state commit. */
  shutdownWorktreeTerminals: (
    worktreeId: string,
    opts?: {
      keepIdentifiers?: boolean
      shutdownReason?: AgentStatusWorktreeShutdownReason
      sleepingPaneKeys?: string[]
      expectedRuntimePtyIds?: string[]
      backendOwnsPtyTeardown?: boolean
    }
  ) => Promise<void>
  /** Captures resumable pane evidence and publishes suppression before exact physical teardown. */
  shutdownCompletedAgentPaneForHibernation: (
    worktreeId: string,
    opts: {
      paneKey: string
      tabId: string
      leafId: string
      ptyId: string
      expectedRuntimePtyId?: string
    }
  ) => Promise<void>
  suppressPtyExit: (ptyId: string) => void
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  isPtyShutdownPending: (ptyId: string) => boolean
  queueCodexPaneRestarts: (ptyIds: string[]) => void
  consumePendingCodexPaneRestart: (ptyId: string) => boolean
  markCodexRestartNotices: (
    notices: (Pick<CodexRestartNotice, 'previousAccountLabel' | 'nextAccountLabel'> &
      Partial<Pick<CodexRestartNotice, 'previousAccountId' | 'nextAccountId'>> & {
        homeRouteChanged?: boolean
        ptyId: string
      })[]
  ) => string[]
  clearCodexRestartNotice: (ptyId: string) => void
  dismissCodexRestartNotices: (ptyIds: string[]) => void
  reopenCodexRestartPrompt: (ptyId: string) => void
  replaceTerminalLayoutPanePtyId: (tabId: string, leafId: string, ptyId: string) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  setTabCanExpandPane: (tabId: string, canExpand: boolean) => void
  setTabLayout: (tabId: string, layout: TerminalLayoutSnapshot | null) => void
  syncPaneDetachPtyOwnership: (args: {
    detachedLeafId: string
    detachedPtyId: string | null
    sourceLayout: TerminalLayoutSnapshot
    sourceTabId: string
    targetTabId: string
  }) => void
  queueTabStartupCommand: (
    tabId: string,
    startup: {
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
  ) => void
  queueTabInitialCwd: (tabId: string, cwd: string) => void
  consumeTabInitialCwd: (tabId: string) => string | null
  consumeTabStartupCommand: (tabId: string) => {
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
  } | null
  queueTabSetupSplit: (
    tabId: string,
    startup: {
      command: string
      env?: Record<string, string>
      direction: SetupSplitDirection
    }
  ) => void
  consumeTabSetupSplit: (tabId: string) => {
    command: string
    env?: Record<string, string>
    direction: SetupSplitDirection
  } | null
  queueTabIssueCommandSplit: (
    tabId: string,
    issueCommand: {
      command: string
      env?: Record<string, string>
    }
  ) => void
  consumeTabIssueCommandSplit: (tabId: string) => {
    command: string
    env?: Record<string, string>
  } | null
  setCacheTimerStartedAt: (key: string, ts: number | null) => void
  recordTerminalInput: (paneKey: string, timestamp?: number) => void
  seedCacheTimersForIdleTabs: () => void
  setDeferredSshReconnectTargets: (targetIds: string[]) => void
  removeDeferredSshReconnectTarget: (targetId: string) => void
  removeDeferredSshSessionId: (tabId: string) => void
  /** Hydrates canonical rows first, then transfers normalized pane authority post-publication. */
  hydrateWorkspaceSession: (
    session: WorkspaceSessionState,
    options?: HydrateWorkspaceSessionOptions
  ) => void
  /** Publishes wake hints without spawning; global completion alone opens the readiness gate. */
  reconnectPersistedTerminals: (
    signal?: AbortSignal,
    options?: ReconnectPersistedTerminalsOptions
  ) => Promise<void>
}
