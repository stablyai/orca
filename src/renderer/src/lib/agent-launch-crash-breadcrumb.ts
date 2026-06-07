import { useAppStore } from '@/store'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting'
import type { LaunchSource, RequestKind } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/types'
import { CLIENT_PLATFORM } from './new-workspace'
import { recordRendererCrashBreadcrumb } from './crash-diagnostics'

type WorktreeRuntimeCrashContext = {
  activeRuntime: string
  wslDistroPresent: boolean
  worktreePathKind: string
}

type WorktreeLookupState = {
  getKnownWorktreeById?: (worktreeId: string) => { path?: unknown } | undefined
  activeTabType?: unknown
  tabsByWorktree?: Record<string, readonly unknown[] | undefined>
  agentStatusByPaneKey?: Record<string, { agentType?: unknown } | undefined>
}

export type AgentLaunchCrashBreadcrumbArgs = {
  agent: TuiAgent
  worktreeId: string
  launchPlatform: NodeJS.Platform
  launchSource?: LaunchSource
  requestKind?: RequestKind
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  hasPrompt?: boolean
}

export function recordAgentLaunchCrashBreadcrumb(args: AgentLaunchCrashBreadcrumbArgs): void {
  const data: CrashReportBreadcrumbData = {
    agent: args.agent,
    launchPlatform: args.launchPlatform,
    ...getWorktreeRuntimeCrashContext(args.worktreeId, args.launchPlatform),
    ...getWorkspaceSurfaceCrashContext(args.worktreeId)
  }

  if (args.launchSource) {
    data.launchSource = args.launchSource
  }
  if (args.requestKind) {
    data.requestKind = args.requestKind
  }
  if (args.promptDelivery) {
    data.promptDelivery = args.promptDelivery
  }
  if (typeof args.hasPrompt === 'boolean') {
    data.hasPrompt = args.hasPrompt
  }

  recordRendererCrashBreadcrumb('agent_launch_queued', data)
}

function getWorktreeRuntimeCrashContext(
  worktreeId: string,
  launchPlatform: NodeJS.Platform
): WorktreeRuntimeCrashContext {
  const pathValue = getWorktreePath(worktreeId)
  if (pathValue && parseWslUncPath(pathValue)) {
    return {
      activeRuntime: 'wsl',
      wslDistroPresent: true,
      worktreePathKind: 'wsl-unc'
    }
  }

  if (pathValue?.startsWith('\\\\')) {
    return {
      activeRuntime: launchPlatform === CLIENT_PLATFORM ? 'host' : 'remote',
      wslDistroPresent: false,
      worktreePathKind: 'windows-unc'
    }
  }

  if (pathValue?.startsWith('/')) {
    return {
      activeRuntime:
        CLIENT_PLATFORM === 'win32' && launchPlatform === 'linux' ? 'remote-linux' : 'host',
      wslDistroPresent: false,
      worktreePathKind: 'posix'
    }
  }

  if (pathValue) {
    return {
      activeRuntime: launchPlatform === CLIENT_PLATFORM ? 'host' : 'remote',
      wslDistroPresent: false,
      worktreePathKind: 'local'
    }
  }

  return {
    activeRuntime: launchPlatform === CLIENT_PLATFORM ? 'host' : 'remote',
    wslDistroPresent: false,
    worktreePathKind: 'unknown'
  }
}

function getWorktreePath(worktreeId: string): string | null {
  const state = useAppStore.getState() as WorktreeLookupState
  const worktree = state.getKnownWorktreeById?.(worktreeId)
  return typeof worktree?.path === 'string' ? worktree.path : null
}

function getWorkspaceSurfaceCrashContext(worktreeId: string): CrashReportBreadcrumbData {
  const state = useAppStore.getState() as WorktreeLookupState
  const data: CrashReportBreadcrumbData = {}
  if (typeof state.activeTabType === 'string') {
    data.activeTabType = state.activeTabType
  }

  const tabs = state.tabsByWorktree?.[worktreeId]
  if (Array.isArray(tabs)) {
    data.terminalCount = tabs.length
  }

  const activeAgentTypes = getActiveAgentTypes(state, tabs)
  data.activeAgentCount = activeAgentTypes.length
  if (activeAgentTypes.length > 0) {
    data.activeAgentTypes = activeAgentTypes.join(',')
  }

  return data
}

function getActiveAgentTypes(
  state: WorktreeLookupState,
  tabs: readonly unknown[] | undefined
): string[] {
  if (!Array.isArray(tabs) || !state.agentStatusByPaneKey) {
    return []
  }
  const tabPrefixes = tabs
    .map((tab) => (isTabWithId(tab) ? `${tab.id}:` : null))
    .filter((prefix): prefix is string => prefix !== null)
  if (tabPrefixes.length === 0) {
    return []
  }

  const types = new Set<string>()
  for (const [paneKey, status] of Object.entries(state.agentStatusByPaneKey)) {
    if (!tabPrefixes.some((prefix) => paneKey.startsWith(prefix))) {
      continue
    }
    if (typeof status?.agentType === 'string' && status.agentType.length > 0) {
      types.add(status.agentType)
    }
  }
  return [...types].sort().slice(0, 8)
}

function isTabWithId(value: unknown): value is { id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof (value as { id?: unknown }).id === 'string'
  )
}
