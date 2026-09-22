import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  resolveNativeChatImageRuntimeContext,
  selectNativeChatImageOwnerState
} from './native-chat-image-runtime-context'

function state(): AppState {
  const tab: TerminalTab = {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  const worktree = {
    id: 'wt-1',
    repoId: 'repo',
    path: '/repo/worktree',
    hostId: 'local'
  }
  return {
    activeWorkspaceExecutionHostId: 'local',
    activeWorktreeId: 'wt-1',
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    getKnownWorktreeById: () => worktree,
    projectGroups: [],
    removedRuntimeEnvironmentIds: new Set(),
    repos: [{ id: 'repo', path: '/repo' }],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    runtimeEnvironmentCatalogHydrated: true,
    runtimeEnvironments: [],
    settings: { activeRuntimeEnvironmentId: null },
    sshConnectionStates: {},
    sshStateByEnvironment: {},
    tabsByWorktree: { 'wt-1': [tab] },
    unifiedTabsByWorktree: {},
    worktreesByRepo: { repo: [worktree] }
  } as unknown as AppState
}

describe('resolveNativeChatImageRuntimeContext', () => {
  it('keeps unrelated store writes out of the image-owner selector', () => {
    const storeState = state()
    const first = selectNativeChatImageOwnerState(storeState)
    const second = selectNativeChatImageOwnerState({
      ...storeState,
      agentStatusByPaneKey: {} as AppState['agentStatusByPaneKey']
    })

    expect(shallow(second, first)).toBe(true)
  })

  it('reuses derived settings when owner inputs are unchanged', () => {
    const storeState = state()
    const first = resolveNativeChatImageRuntimeContext(storeState, 'tab-1')
    const second = resolveNativeChatImageRuntimeContext(storeState, 'tab-1')

    expect(first).not.toBeNull()
    expect(second?.settings).toBe(first?.settings)
    expect(shallow(second, first)).toBe(true)
  })

  it('derives a runtime host from an owner-only route during paired hydration', () => {
    const storeState = state()
    const ownerOnlyWorktree = {
      id: 'wt-1',
      repoId: 'repo',
      path: '/repo/worktree',
      runtimeOwnerEnvironmentId: 'owner-a'
    }
    const ownerState = {
      ...storeState,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      getKnownWorktreeById: () => ownerOnlyWorktree,
      worktreesByRepo: { repo: [ownerOnlyWorktree] },
      runtimeEnvironments: [{ id: 'owner-a' }]
    } as unknown as AppState

    const context = resolveNativeChatImageRuntimeContext(ownerState, 'tab-1')

    expect(context).toMatchObject({
      worktreeId: 'wt-1',
      worktreePath: '/repo/worktree',
      expectedExecutionHostId: 'local',
      settings: { activeRuntimeEnvironmentId: 'owner-a' }
    })
  })
})
