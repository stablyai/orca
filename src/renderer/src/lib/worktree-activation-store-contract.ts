import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { Tab } from '../../../shared/tab-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { SetupSplitDirection } from '../../../shared/worktree/launch-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'

export type WorktreeActivationStore = Partial<WorktreeRuntimeOwnerState> & {
  tabsByWorktree: Record<string, { id: string }[]>
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
  queueTabStartupCommand: (
    tabId: string,
    startup: {
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
  ) => void
  queueTabSetupSplit: (
    tabId: string,
    startup: { command: string; env?: Record<string, string>; direction: SetupSplitDirection }
  ) => void
  queueTabIssueCommandSplit: (
    tabId: string,
    startup: { command: string; env?: Record<string, string> }
  ) => void
  queueTabInitialCwd: (tabId: string, cwd: string) => void
  settings?: Pick<GlobalSettings, 'experimentalNativeChat' | 'openAgentTabsInChatByDefault'> | null
}

export type InitialTerminalOptions = {
  activateCreatedTabs?: boolean
  backendStartupTerminalSpawned?: boolean
  /** Create a preserved fallback startup beside setup/default terminals. */
  createNewTerminalForStartup?: boolean
  /** Why: an explicit empty terminal row is a "user closed the last tab" tombstone. Startup
   *  hydration honours it through Terminal.tsx's passive auto-create (which never calls this
   *  function), but opening the workspace on purpose (sidebar, palette, automation "Resume
   *  workspace", wake) has to hand back a usable surface. Activation sets this unless the
   *  caller says it provides its own surface; background worktree creation leaves it unset. */
  reseedEmptiedWorkspace?: boolean
}
