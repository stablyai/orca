import type { ExecutionHostId } from '../../../shared/execution-host'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Tab } from '../../../shared/tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { ClosedTerminalTabTombstonesByTabId } from '../../../shared/closed-terminal-tab-tombstones'

export type WorktreeActivationStore = Partial<WorktreeRuntimeOwnerState> & {
  tabsByWorktree: Record<string, { id: string }[]>
  closedTerminalTabTombstonesByTabId?: ClosedTerminalTabTombstonesByTabId
  defaultTerminalTabsAppliedByWorktreeId: Record<string, true>
  createTab: (
    worktreeId: string,
    targetGroupId?: string,
    shellOverride?: string,
    options?: {
      pendingActivationSpawn?: boolean
      launchAgent?: TuiAgent
      recordInteraction?: boolean
      viewMode?: Tab['viewMode']
      activate?: boolean
      pendingStartup?: {
        command: string
        env?: Record<string, string>
        launchConfig?: SleepingAgentLaunchConfig
        resumeProviderSession?: AgentProviderSessionMetadata
        launchToken?: string
        launchAgent?: TuiAgent
        draftPrompt?: string
        initialAgentStatus?: { agent: TuiAgent; prompt: string }
        showSessionRestoredBanner?: boolean
        telemetry?: AgentStartedTelemetry
      }
    }
  ) => { id: string }
  setActiveTab: (tabId: string) => void
  setTabCustomTitle: (
    tabId: string,
    title: string | null,
    opts?: { recordInteraction?: boolean }
  ) => void
  setTabColor: (tabId: string, color: string | null) => void
  markDefaultTerminalTabsApplied: (worktreeId: string) => void
  reconcileWorktreeTabModel: (worktreeId: string) => { renderableTabCount: number }
  queueTabIssueCommandSplit: (
    tabId: string,
    startup: { command: string; env?: Record<string, string> }
  ) => void
  queueTabInitialCwd: (tabId: string, cwd: string) => void
  settings?: Pick<GlobalSettings, 'experimentalNativeChat'> | null
}

export type InitialTerminalOptions = {
  activateCreatedTabs?: boolean
  backendStartupTerminalSpawned?: boolean
  /** Create a preserved fallback startup beside setup/default terminals. */
  createNewTerminalForStartup?: boolean
  /** Explicit empty rows preserve last-close tombstones during passive startup. Deliberate activation may request a usable surface unless the caller supplies its own; background creation leaves this unset. */
  reseedEmptiedWorkspace?: boolean
  // Native-chat callers provide their own primary surface; setup/issue work still runs without seeding an extra shell.
  callerProvidesSurface?: boolean
  /** The user deliberately opened this workspace with no surface choice, so it may open their
   *  default agent chat instead of a bare shell. */
  seedUserDefaultSurface?: boolean
  /** The host a create targeted: a same-path twin on another host cannot make the owner ambiguous. */
  executionHostId?: ExecutionHostId
}
