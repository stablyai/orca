import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  closeWebRuntimeSessionTabMock,
  getStateMock,
  isWebRuntimeSessionActiveMock,
  resolveHostSessionTabIdForWebSessionTabMock
} = vi.hoisted(() => ({
  closeWebRuntimeSessionTabMock: vi.fn(),
  getStateMock: vi.fn(),
  isWebRuntimeSessionActiveMock: vi.fn(() => false),
  resolveHostSessionTabIdForWebSessionTabMock: vi.fn<() => string | null>(() => null)
}))

vi.mock('@/store', () => ({ useAppStore: { getState: getStateMock } }))
vi.mock('@/runtime/web-runtime-session', () => ({
  closeWebRuntimeSessionTab: closeWebRuntimeSessionTabMock,
  isWebRuntimeSessionActive: isWebRuntimeSessionActiveMock,
  toHostSessionTabId: vi.fn((tabId: string) => tabId)
}))
vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => 'epoch-1'),
  resolveHostSessionTabIdForWebSessionTab: resolveHostSessionTabIdForWebSessionTabMock
}))

import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { closeTerminalTab } from './terminal-tab-actions'

describe('terminal window retirement close actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isWebRuntimeSessionActiveMock.mockReturnValue(false)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue(null)
  })

  it('submits a precomputed rowless retirement plan through the existing close action', () => {
    const closeTab = vi.fn()
    const retirementPlan = {
      tabId: 'rowless-tab',
      worktreeId: null,
      ptyIds: ['owned-pty'],
      localOrSshPtyIds: ['owned-pty'],
      runtimeTerminals: [],
      cleanupOnlyPtyIds: [],
      sharedPtyIds: [],
      unroutablePtyIds: []
    }
    getStateMock.mockReturnValue({ tabsByWorktree: {}, unifiedTabsByWorktree: {}, closeTab })

    closeTerminalTab('rowless-tab', {
      force: true,
      skipRunningProcessConfirm: true,
      precomputedRetirementPlan: retirementPlan
    })

    expect(closeTab).toHaveBeenCalledWith('rowless-tab', {
      reason: 'user',
      precomputedRetirementPlan: retirementPlan
    })
  })

  it('uses a precomputed folder-tab owner instead of the focused runtime guess', () => {
    const worktreeId = folderWorkspaceKey('folder-1')
    const closeTab = vi.fn()
    const retirementPlan = {
      tabId: 'local-tab',
      worktreeId,
      ptyIds: ['local-pty'],
      localOrSshPtyIds: ['local-pty'],
      runtimeTerminals: [],
      cleanupOnlyPtyIds: [],
      sharedPtyIds: [],
      unroutablePtyIds: []
    }
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
      runtimeEnvironments: [{ id: 'focused-runtime' }],
      folderWorkspaces: [{ id: 'folder-1', projectGroupId: 'group-1', connectionId: null }],
      projectGroups: [{ id: 'group-1', connectionId: null, executionHostId: null }],
      tabsByWorktree: { [worktreeId]: [{ id: 'local-tab', ptyId: 'local-pty' }] },
      unifiedTabsByWorktree: {},
      activeWorktreeId: worktreeId,
      activeTabId: 'local-tab',
      openFiles: [],
      browserTabsByWorktree: {},
      closeTab,
      setActiveWorktree: vi.fn()
    })

    closeTerminalTab('local-tab', {
      force: true,
      skipRunningProcessConfirm: true,
      precomputedRetirementPlan: retirementPlan
    })

    expect(closeTab).toHaveBeenCalledWith('local-tab', {
      reason: undefined,
      precomputedRetirementPlan: retirementPlan
    })
    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
  })

  it('keeps the existing host-close path when the precomputed owner matches it', () => {
    const closeTab = vi.fn()
    const retirementPlan = {
      tabId: 'runtime-tab',
      worktreeId: 'wt-runtime',
      ptyIds: ['remote:web-runtime@@handle-1'],
      localOrSshPtyIds: [],
      runtimeTerminals: [
        {
          ptyId: 'remote:web-runtime@@handle-1',
          environmentId: 'web-runtime',
          handle: 'handle-1'
        }
      ],
      cleanupOnlyPtyIds: [],
      sharedPtyIds: [],
      unroutablePtyIds: []
    }
    isWebRuntimeSessionActiveMock.mockReturnValue(true)
    resolveHostSessionTabIdForWebSessionTabMock.mockReturnValue('host-tab')
    getStateMock.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: 'web-runtime' },
      repos: [{ id: 'repo-runtime', connectionId: null, executionHostId: 'runtime:web-runtime' }],
      worktreesByRepo: {
        'repo-runtime': [
          { id: 'wt-runtime', repoId: 'repo-runtime', hostId: 'runtime:web-runtime' }
        ]
      },
      tabsByWorktree: { 'wt-runtime': [{ id: 'runtime-tab' }] },
      unifiedTabsByWorktree: {},
      activeWorktreeId: 'wt-runtime',
      activeTabId: 'runtime-tab',
      openFiles: [],
      browserTabsByWorktree: {},
      closeTab,
      setActiveWorktree: vi.fn(),
      setActiveTab: vi.fn()
    })

    closeTerminalTab('runtime-tab', {
      force: true,
      skipRunningProcessConfirm: true,
      precomputedRetirementPlan: retirementPlan
    })

    expect(closeTab).toHaveBeenCalledWith('runtime-tab', {
      reason: undefined,
      remoteCloseOwnedByHost: true,
      precomputedRetirementPlan: retirementPlan
    })
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-runtime',
      tabId: 'host-tab',
      environmentId: 'web-runtime',
      reason: 'user'
    })
  })
})
