import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/types'
import { useAppStore } from '@/store'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  activateAndRevealFolderWorkspace,
  buildFolderWorkspaceAgentReopenStartup
} from './worktree-activation'

const initialAppStoreState = useAppStore.getState()

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: 'mission:m1',
    missionId: 'm1',
    name: 'Referral',
    folderPath: '/home/u/orca/missions/referral',
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function seedSettings(): void {
  useAppStore.setState({
    repos: [],
    settings: {
      agentCmdOverrides: {},
      setupScriptLaunchMode: 'new-tab'
    } as unknown as ReturnType<typeof useAppStore.getState>['settings']
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

describe('buildFolderWorkspaceAgentReopenStartup', () => {
  it('relaunches the agent a mission session was created with', () => {
    seedSettings()
    const startup = buildFolderWorkspaceAgentReopenStartup(
      makeFolderWorkspace({ createdWithAgent: 'codex' })
    )
    expect(startup).toMatchObject({
      command: "codex '--dangerously-bypass-approvals-and-sandbox'",
      launchAgent: 'codex',
      telemetry: { agent_kind: 'codex', launch_source: 'sidebar', request_kind: 'resume' }
    })
  })

  it('returns no startup for an agentless folder workspace (plain shell, no regression)', () => {
    seedSettings()
    expect(buildFolderWorkspaceAgentReopenStartup(makeFolderWorkspace())).toBeUndefined()
  })

  it('still builds a startup for a remote (SSH) folder workspace', () => {
    seedSettings()
    // A folder workspace has no repoId to resolve, so host provenance must come
    // from its own connectionId/path — a remote session must not silently fall
    // back to a bare shell.
    const startup = buildFolderWorkspaceAgentReopenStartup(
      makeFolderWorkspace({
        createdWithAgent: 'codex',
        connectionId: 'ssh-1',
        folderPath: '/home/remote/project'
      })
    )
    expect(startup?.launchAgent).toBe('codex')
  })
})

describe('activateAndRevealFolderWorkspace agent reopen wiring', () => {
  it('launches the created agent when opening an empty mission session terminal', () => {
    const workspace = makeFolderWorkspace({ createdWithAgent: 'codex' })
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const revealWorktreeInSidebar = vi.fn()

    useAppStore.setState({
      repos: [],
      folderWorkspaces: [workspace],
      worktreesByRepo: {},
      activeView: 'terminal',
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {},
      activeFileIdByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      activeTabTypeByWorktree: {},
      activeTabIdByWorktree: {},
      tabBarOrderByWorktree: {},
      pendingStartupByTabId: {},
      settings: {
        agentCmdOverrides: {},
        setupScriptLaunchMode: 'new-tab'
      } as unknown as ReturnType<typeof useAppStore.getState>['settings'],
      // Why: skip the real path-status lookup (null never blocks activation).
      getFreshFolderWorkspacePathStatus: () => null,
      setActiveFolderWorkspace: vi.fn(),
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn(),
      revealWorktreeInSidebar
    } as unknown as Parameters<typeof useAppStore.setState>[0])

    const result = activateAndRevealFolderWorkspace(workspace.id)
    const state = useAppStore.getState()
    const reopenedTab = state.tabsByWorktree[workspaceKey]?.[0]

    expect(result).not.toBe(false)
    expect(reopenedTab).toBeDefined()
    expect(state.pendingStartupByTabId[reopenedTab!.id]).toMatchObject({
      command: "codex '--dangerously-bypass-approvals-and-sandbox'",
      launchAgent: 'codex',
      telemetry: { agent_kind: 'codex', launch_source: 'sidebar', request_kind: 'resume' }
    })
    expect(revealWorktreeInSidebar).toHaveBeenCalledWith(workspaceKey)
  })

  it('opens a bare shell for an agentless folder workspace', () => {
    const workspace = makeFolderWorkspace({ id: 'fw-plain', projectGroupId: 'group-1' })
    delete (workspace as { missionId?: string }).missionId
    const workspaceKey = folderWorkspaceKey(workspace.id)

    useAppStore.setState({
      repos: [],
      folderWorkspaces: [workspace],
      worktreesByRepo: {},
      activeView: 'terminal',
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      openFiles: [],
      browserTabsByWorktree: {},
      activeFileIdByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      activeTabTypeByWorktree: {},
      activeTabIdByWorktree: {},
      tabBarOrderByWorktree: {},
      pendingStartupByTabId: {},
      settings: {
        agentCmdOverrides: {},
        setupScriptLaunchMode: 'new-tab'
      } as unknown as ReturnType<typeof useAppStore.getState>['settings'],
      getFreshFolderWorkspacePathStatus: () => null,
      setActiveFolderWorkspace: vi.fn(),
      markWorktreeVisited: vi.fn(),
      recordWorktreeVisit: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn(),
      revealWorktreeInSidebar: vi.fn()
    } as unknown as Parameters<typeof useAppStore.setState>[0])

    activateAndRevealFolderWorkspace(workspace.id)
    const state = useAppStore.getState()
    const reopenedTab = state.tabsByWorktree[workspaceKey]?.[0]

    expect(reopenedTab).toBeDefined()
    expect(state.pendingStartupByTabId[reopenedTab!.id]).toBeUndefined()
  })
})

describe('buildFolderWorkspaceAgentReopenStartup host routing', () => {
  it('passes the folder workspace connectionId through as isRemote', async () => {
    vi.resetModules()
    const buildAgentStartupPlan = vi.fn(() => ({
      agent: 'codex',
      launchCommand: 'codex',
      launchConfig: { agentCommand: 'codex' },
      expectedProcess: 'codex',
      followupPrompt: null
    }))
    vi.doMock('./tui-agent-startup', async () => ({
      ...(await vi.importActual('./tui-agent-startup')),
      buildAgentStartupPlan
    }))
    const { buildFolderWorkspaceAgentReopenStartup: build } = await import('./worktree-activation')
    const { useAppStore: store } = await import('@/store')
    store.setState({
      repos: [],
      settings: {
        agentCmdOverrides: {},
        setupScriptLaunchMode: 'new-tab'
      } as unknown as ReturnType<typeof store.getState>['settings']
    })

    build(makeFolderWorkspace({ createdWithAgent: 'codex' }))
    build(
      makeFolderWorkspace({
        createdWithAgent: 'codex',
        connectionId: 'ssh-1',
        folderPath: '/home/remote/project'
      })
    )

    expect(buildAgentStartupPlan).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ isRemote: false })
    )
    expect(buildAgentStartupPlan).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ isRemote: true })
    )
    vi.doUnmock('./tui-agent-startup')
    vi.resetModules()
  })
})
