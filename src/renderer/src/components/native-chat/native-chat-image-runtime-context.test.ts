import { createTestStore, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { getDefaultSettings } from '../../../../shared/constants'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  resolveNativeChatImageRuntimeContext,
  selectNativeChatImageOwnerState
} from './native-chat-image-runtime-context'

/** Build a typed transcript owner fixture with all SSH authority maps present. */
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
  const worktree = makeWorktree({
    id: 'wt-1',
    repoId: 'repo',
    path: '/repo/worktree',
    hostId: 'local'
  })
  return {
    ...createTestStore().getState(),
    activeWorkspaceExecutionHostId: 'local',
    activeWorktreeId: 'wt-1',
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    getKnownWorktreeById: () => worktree,
    projectGroups: [],
    removedRuntimeEnvironmentIds: new Set(),
    repos: [{ ...TEST_REPO, id: 'repo', path: '/repo' }],
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    runtimeEnvironmentCatalogHydrated: true,
    runtimeEnvironments: [],
    settings: { ...getDefaultSettings('/home/test'), activeRuntimeEnvironmentId: null },
    runtimeOwnedSshConnectionStates: new Map(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    tabsByWorktree: { 'wt-1': [tab] },
    unifiedTabsByWorktree: {},
    worktreesByRepo: { repo: [worktree] }
  }
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

it('keeps recipe VM image authority in the selected state and updates it on reconnect', () => {
  const targetId = 'runtime-ssh-image-vm'
  const hostId = toSshExecutionHostId(targetId)
  const worktree = makeWorktree({ id: 'wt-1', repoId: 'repo', path: '/workspace/repo', hostId })
  const connection = {
    targetId,
    status: 'connected' as const,
    error: null,
    reconnectAttempt: 0,
    connectionGeneration: 42
  }
  const storeState: AppState = {
    ...state(),
    activeWorkspaceExecutionHostId: hostId,
    worktreesByRepo: { repo: [worktree] },
    getKnownWorktreeById: () => worktree,
    runtimeOwnedSshConnectionStates: new Map([[targetId, connection]])
  }
  const selected = selectNativeChatImageOwnerState(storeState)
  expect(resolveNativeChatImageRuntimeContext(selected, 'tab-1')).toMatchObject({
    worktreePath: '/workspace/repo',
    connectionId: targetId,
    expectedExternalSshTargetId: targetId,
    expectedExecutionHostId: hostId,
    expectedSshConnectionGeneration: 42
  })
  const disconnected = selectNativeChatImageOwnerState({
    ...storeState,
    runtimeOwnedSshConnectionStates: new Map([
      [targetId, { ...connection, status: 'disconnected' }]
    ])
  })
  expect(shallow(selected, disconnected)).toBe(false)
  expect(resolveNativeChatImageRuntimeContext(disconnected, 'tab-1')).toBeNull()
  const reconnected = selectNativeChatImageOwnerState({
    ...storeState,
    runtimeOwnedSshConnectionStates: new Map([
      [targetId, { ...connection, connectionGeneration: 43 }]
    ])
  })
  expect(
    resolveNativeChatImageRuntimeContext(reconnected, 'tab-1')?.expectedSshConnectionGeneration
  ).toBe(43)
})
