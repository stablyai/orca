import type { vi } from 'vitest'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { resolveWindowsShiftEnterEncodingForPane } from './terminal-windows-shift-enter'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'

export type StoreState = {
  activeWorktreeId: string | null
  tabsByWorktree: Record<
    string,
    {
      id: string
      ptyId: string | null
      title?: string
      launchAgent?: string
      shellOverride?: string
      forceHostRuntime?: boolean
      generation?: number
    }[]
  >
  ptyIdsByTabId?: Record<string, string[]>
  terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot>
  unreadTerminalTabs?: Record<string, true>
  deleteStateByWorktreeId?: Record<string, { isDeleting?: boolean; phase?: string }>
  worktreesByRepo: Record<
    string,
    {
      id: string
      repoId: string
      path: string
      displayName?: string
      branch?: string
      workspaceStatus?: string
      hostId?: string
      runtimeOwnerEnvironmentId?: string
    }[]
  >
  runtimeEnvironments?: { id: string }[]
  runtimeStatusByEnvironmentId: Map<
    string,
    {
      checkedAt: number
      status: { capabilities?: string[] } | null
    }
  >
  runtimeEnvironmentCatalogHydrated?: boolean
  repos: {
    id: string
    connectionId?: string | null
    displayName?: string
    executionHostId?: string | null
  }[]
  projects: {
    id: string
    localWindowsRuntimePreference?:
      | { kind: 'inherit-global' }
      | { kind: 'windows-host' }
      | { kind: 'wsl'; distro: string }
  }[]
  sshConnectionStates: Map<string, { status: string }>
  transientClearedAgentStatusConnectionIds: Record<string, true>
  cacheTimerByKey: Record<string, number | null>
  settings: {
    theme?: 'system' | 'dark' | 'light'
    promptCacheTimerEnabled?: boolean
    activeRuntimeEnvironmentId?: string | null
    experimentalTerminalAttention?: boolean
    terminalWindowsShell?: string
    terminalWindowsWslDistro?: string | null
    localWindowsRuntimeDefault?: { kind: 'windows-host' } | { kind: 'wsl'; distro: string | null }
    terminalMainSideEffectAuthority?: boolean
    terminalHiddenDeliveryGate?: boolean
    notifications?: {
      enabled?: boolean
      agentTaskComplete?: boolean
      terminalBell?: boolean
      suppressWhenFocused?: boolean
      customSoundPath?: string | null
    }
    agentCmdOverrides?: Record<string, string>
    agentDefaultArgs?: Record<string, string>
    agentDefaultEnv?: Record<string, Record<string, string>>
  } | null
  codexRestartNoticeByPtyId: Record<
    string,
    {
      previousAccountLabel: string
      nextAccountLabel: string
      restartRequested?: true
      dismissed?: true
    }
  >
  deferredSshReconnectTargets: string[]
  deferredSshSessionIdsByTabId: Record<string, string>
  removeDeferredSshReconnectTarget: ReturnType<typeof vi.fn>
  removeDeferredSshSessionId: ReturnType<typeof vi.fn>
  consumePendingColdRestore: ReturnType<typeof vi.fn>
  consumePendingSnapshot: ReturnType<typeof vi.fn>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  agentStatusByPaneKey: Record<string, unknown>
  retainedAgentsByPaneKey: Record<string, { agentType: AgentType }>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  sleepingAgentSessionsByPaneKey: Record<string, unknown>
  suppressedPtyExitIds: Record<string, true>
  agentLaunchConfigByPaneKey: Record<
    string,
    { launchConfig: unknown; identity?: { agentType?: string } }
  >
  getAgentLaunchConfigForStatusEntry: ReturnType<typeof vi.fn>
  getAgentLaunchConfigForStatusMetadata: ReturnType<typeof vi.fn>
  clearSleepingAgentSession: ReturnType<typeof vi.fn>
  registerAgentLaunchConfig: ReturnType<typeof vi.fn>
  clearAgentLaunchConfig: ReturnType<typeof vi.fn>
  markWorktreeUnread: ReturnType<typeof vi.fn>
  observeTerminalGitHubPullRequestLink: ReturnType<typeof vi.fn>
  recordTerminalInput: ReturnType<typeof vi.fn>
  setAgentStatus: ReturnType<typeof vi.fn>
  removeAgentStatus: ReturnType<typeof vi.fn>
  dropAgentStatus: ReturnType<typeof vi.fn>
  retireAgentPaneAuthority: ReturnType<typeof vi.fn>
  restoreAgentPaneAuthority: ReturnType<typeof vi.fn>
  setPaneForegroundAgent: ReturnType<typeof vi.fn>
  clearPaneForegroundAgent: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
  markAgentCompletionPaneUnread: ReturnType<typeof vi.fn>
  directSshPaneRetryByTabId?: Record<
    string,
    {
      attemptId: string
      authority: {
        targetId: string
        providerEpoch: string
        connectionGeneration: number
      }
      tabGeneration: number
      startedAt: number
    }
  >
  directSshLivePtyBindingByTabId?: Record<
    string,
    {
      attemptId: string
      authority: {
        targetId: string
        providerEpoch: string
        connectionGeneration: number
      }
      tabGeneration: number
      ptyId: string
    }
  >
  settleDirectSshPaneRetry?: ReturnType<typeof vi.fn>
}

export type WindowsShiftEnterPaneState = Parameters<
  typeof resolveWindowsShiftEnterEncodingForPane
>[0]

export function resolveMockPaneWindowsShiftEnterEncoding(
  state: StoreState,
  paneKey: string
): ReturnType<typeof resolveWindowsShiftEnterEncodingForPane> {
  return resolveWindowsShiftEnterEncodingForPane(
    {
      paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey,
      agentLaunchConfigByPaneKey:
        state.agentLaunchConfigByPaneKey as WindowsShiftEnterPaneState['agentLaunchConfigByPaneKey']
    },
    paneKey
  )
}
