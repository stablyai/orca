import { vi } from 'vitest'

export const appStoreSnapshot: {
  activeRepoId: string | null
  activeTabId: string | null
  activeTabType: 'terminal' | 'editor' | 'browser' | 'simulator' | null
  activeRuntimeEnvironmentId: string | null
  activeWorktreeId: string | null
  projects: {
    id: string
    localWindowsRuntimePreference?:
      | { kind: 'inherit-global' | 'windows-host' }
      | {
          kind: 'wsl'
          distro: string
        }
    sourceRepoIds?: string[]
  }[]
  repos: { id: string; connectionId?: string | null }[]
  sshConnectionStates: Map<string, { remotePlatform?: NodeJS.Platform }>
  worktreesByRepo: Record<
    string,
    {
      id: string
      repoId: string
      path?: string
      projectId?: string
      hostId?: 'local' | `runtime:${string}` | `ssh:${string}`
      runtimeOwnerEnvironmentId?: string
    }[]
  >
  unifiedTabsByWorktree: Record<string, unknown[]>
  activeGroupIdByWorktree: Record<string, string>
  detectedAgentIds: string[] | null
  localDetectedAgentIdsByContext: Record<string, string[] | null>
  remoteDetectedAgentIds: Record<string, string[]>
  isDetectingAgents: boolean
  isDetectingLocalAgentsByContext: Record<string, boolean>
  isRefreshingLocalAgentsByContext: Record<string, boolean>
  isDetectingRemoteAgents: Record<string, boolean>
} = {
  activeRepoId: null,
  activeTabId: null,
  activeTabType: null,
  activeRuntimeEnvironmentId: null,
  activeWorktreeId: null,
  projects: [],
  repos: [],
  sshConnectionStates: new Map(),
  worktreesByRepo: {},
  unifiedTabsByWorktree: {},
  activeGroupIdByWorktree: {},
  detectedAgentIds: null,
  localDetectedAgentIdsByContext: {},
  remoteDetectedAgentIds: {},
  isDetectingAgents: false,
  isDetectingLocalAgentsByContext: {},
  isRefreshingLocalAgentsByContext: {},
  isDetectingRemoteAgents: {}
}
export const pinTabMock: (tabId: string) => void = vi.fn()
export const unpinTabMock: (tabId: string) => void = vi.fn()

const useAppStoreMock = vi.fn(
  (
    selector: (state: {
      activeRepoId: string | null
      activeTabId: string | null
      activeTabType: 'terminal' | 'editor' | 'browser' | 'simulator' | null
      activeWorktreeId: string | null
      gitStatusByWorktree: Record<string, never[]>
      projects: typeof appStoreSnapshot.projects
      repos: { id: string; connectionId?: string | null }[]
      sshConnectionStates: Map<string, { remotePlatform?: NodeJS.Platform }>
      worktreesByRepo: typeof appStoreSnapshot.worktreesByRepo
      unifiedTabsByWorktree: Record<string, unknown[]>
      activeGroupIdByWorktree: Record<string, string>
      detectedAgentIds: string[] | null
      localDetectedAgentIdsByContext: Record<string, string[] | null>
      remoteDetectedAgentIds: Record<string, string[]>
      isDetectingAgents: boolean
      isDetectingLocalAgentsByContext: Record<string, boolean>
      isRefreshingLocalAgentsByContext: Record<string, boolean>
      isDetectingRemoteAgents: Record<string, boolean>
      pinTab: typeof pinTabMock
      unpinTab: typeof unpinTabMock
      settings: {
        terminalWindowsShell: 'powershell.exe' | 'cmd.exe' | 'wsl.exe' | 'git-bash'
        terminalWindowsPowerShellImplementation: 'auto' | 'powershell.exe' | 'pwsh.exe'
        activeRuntimeEnvironmentId: string | null
        localWindowsRuntimeDefault: { kind: 'windows-host' } | { kind: 'wsl'; distro: string }
      }
    }) => unknown
  ) =>
    selector({
      activeRepoId: appStoreSnapshot.activeRepoId,
      activeTabId: appStoreSnapshot.activeTabId,
      activeTabType: appStoreSnapshot.activeTabType,
      activeWorktreeId: appStoreSnapshot.activeWorktreeId,
      gitStatusByWorktree: {},
      projects: appStoreSnapshot.projects,
      repos: appStoreSnapshot.repos,
      sshConnectionStates: appStoreSnapshot.sshConnectionStates,
      worktreesByRepo: appStoreSnapshot.worktreesByRepo,
      unifiedTabsByWorktree: appStoreSnapshot.unifiedTabsByWorktree,
      activeGroupIdByWorktree: appStoreSnapshot.activeGroupIdByWorktree,
      detectedAgentIds: appStoreSnapshot.detectedAgentIds,
      localDetectedAgentIdsByContext: appStoreSnapshot.localDetectedAgentIdsByContext,
      remoteDetectedAgentIds: appStoreSnapshot.remoteDetectedAgentIds,
      isDetectingAgents: appStoreSnapshot.isDetectingAgents,
      isDetectingLocalAgentsByContext: appStoreSnapshot.isDetectingLocalAgentsByContext,
      isRefreshingLocalAgentsByContext: appStoreSnapshot.isRefreshingLocalAgentsByContext,
      isDetectingRemoteAgents: appStoreSnapshot.isDetectingRemoteAgents,
      pinTab: pinTabMock,
      unpinTab: unpinTabMock,
      settings: {
        terminalWindowsShell: 'powershell.exe',
        terminalWindowsPowerShellImplementation: 'pwsh.exe',
        activeRuntimeEnvironmentId: appStoreSnapshot.activeRuntimeEnvironmentId,
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      }
    })
)

export const useAppStoreExport = (selector: Parameters<typeof useAppStoreMock>[0]): unknown =>
  useAppStoreMock(selector)
useAppStoreExport.getState = vi.fn(() => ({
  activeRepoId: appStoreSnapshot.activeRepoId,
  activeTabId: appStoreSnapshot.activeTabId,
  activeTabType: appStoreSnapshot.activeTabType,
  activeWorktreeId: appStoreSnapshot.activeWorktreeId,
  gitStatusByWorktree: {},
  projects: appStoreSnapshot.projects,
  repos: appStoreSnapshot.repos,
  sshConnectionStates: appStoreSnapshot.sshConnectionStates,
  worktreesByRepo: appStoreSnapshot.worktreesByRepo,
  unifiedTabsByWorktree: appStoreSnapshot.unifiedTabsByWorktree,
  activeGroupIdByWorktree: appStoreSnapshot.activeGroupIdByWorktree,
  detectedAgentIds: appStoreSnapshot.detectedAgentIds,
  localDetectedAgentIdsByContext: appStoreSnapshot.localDetectedAgentIdsByContext,
  remoteDetectedAgentIds: appStoreSnapshot.remoteDetectedAgentIds,
  isDetectingAgents: appStoreSnapshot.isDetectingAgents,
  isDetectingLocalAgentsByContext: appStoreSnapshot.isDetectingLocalAgentsByContext,
  isRefreshingLocalAgentsByContext: appStoreSnapshot.isRefreshingLocalAgentsByContext,
  isDetectingRemoteAgents: appStoreSnapshot.isDetectingRemoteAgents,
  pinTab: pinTabMock,
  unpinTab: unpinTabMock,
  settings: {
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsPowerShellImplementation: 'pwsh.exe',
    activeRuntimeEnvironmentId: appStoreSnapshot.activeRuntimeEnvironmentId,
    localWindowsRuntimeDefault: { kind: 'windows-host' }
  }
}))

export function resetAppStoreSnapshot(): void {
  appStoreSnapshot.activeRepoId = null
  appStoreSnapshot.activeTabId = null
  appStoreSnapshot.activeTabType = null
  appStoreSnapshot.activeRuntimeEnvironmentId = null
  appStoreSnapshot.activeWorktreeId = null
  appStoreSnapshot.projects = []
  appStoreSnapshot.repos = []
  appStoreSnapshot.sshConnectionStates = new Map()
  appStoreSnapshot.worktreesByRepo = {}
  appStoreSnapshot.unifiedTabsByWorktree = {}
  appStoreSnapshot.activeGroupIdByWorktree = {}
  appStoreSnapshot.localDetectedAgentIdsByContext = {}
  appStoreSnapshot.isDetectingLocalAgentsByContext = {}
  appStoreSnapshot.isRefreshingLocalAgentsByContext = {}
}
