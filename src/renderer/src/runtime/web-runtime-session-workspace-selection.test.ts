import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorktreeIdentity } from '../../../shared/worktree/identity'
import type { WorktreeSelectionOwner } from '../../../shared/worktree-selection-owner'
import { createStoreCascadesMockApi } from '../store/slices/store-cascades-test-harness'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import {
  ENVIRONMENT_ID,
  RUNTIME_EXECUTION_HOST_ID,
  WORKTREE_ID,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'
import {
  readActiveWorkspaceSelection,
  restoreActiveWorkspaceSelection
} from './web-runtime-session-workspace-selection'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot,
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    return () => {}
  },
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

const previousOwner: WorktreeSelectionOwner = {
  worktreeId: WORKTREE_ID,
  publisherHostId: 'runtime:publisher-a',
  executionHostId: 'ssh:shared-alias',
  instanceId: 'shared-instance'
}
const appliedOwner: WorktreeSelectionOwner = {
  ...previousOwner,
  publisherHostId: RUNTIME_EXECUTION_HOST_ID
}

function createSelectionStore() {
  const store = createTestStore()
  seedStore(store, {
    activeRepoId: 'repo',
    activeWorktreeId: WORKTREE_ID,
    activeWorkspaceExecutionHostId: previousOwner.executionHostId,
    activeWorkspaceOwner: previousOwner,
    worktreesByRepo: Object.fromEntries(
      [previousOwner, appliedOwner].map((owner) => [
        owner.publisherHostId,
        [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo',
            path: '/worktree',
            hostId: owner.executionHostId,
            runtimeOwnerEnvironmentId: owner.publisherHostId.slice('runtime:'.length),
            instanceId: 'shared-instance',
            identity: createWorktreeIdentity({
              worktreeId: WORKTREE_ID,
              executionHostId: previousOwner.executionHostId,
              instanceId: 'shared-instance'
            })
          })
        ]
      ])
    )
  })
  mocks.getState.mockImplementation(store.getState)
  mocks.setState.mockImplementation(store.setState)
  mocks.subscribe.mockImplementation(store.subscribe)
  return store
}

describe('web runtime workspace selection owner rollback', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
    createStoreCascadesMockApi()
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
  })

  it('captures the publisher and raw host when equal workspace IDs share an SSH alias', () => {
    const store = createSelectionStore()
    const previous = readActiveWorkspaceSelection()

    expect(
      store.getState().setActiveWorktree(WORKTREE_ID, appliedOwner.executionHostId, {
        owner: appliedOwner
      })
    ).toBe(true)
    const applied = readActiveWorkspaceSelection()

    expect(previous).toEqual({
      worktreeId: WORKTREE_ID,
      executionHostId: previousOwner.executionHostId,
      owner: previousOwner
    })
    expect(applied).toEqual({
      worktreeId: WORKTREE_ID,
      executionHostId: previousOwner.executionHostId,
      owner: appliedOwner
    })
  })

  it('restores the exact previous owner after the production create fails', async () => {
    const store = createSelectionStore()
    const setActiveWorktree = vi.spyOn(store.getState(), 'setActiveWorktree')
    const runtimeCall = vi.fn().mockRejectedValue(new Error('selector_not_found'))
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: true
    })

    expect(outcome.status).toBe('failed')
    expect(setActiveWorktree).toHaveBeenLastCalledWith(WORKTREE_ID, previousOwner.executionHostId, {
      owner: previousOwner
    })
    expect(readActiveWorkspaceSelection()).toEqual({
      worktreeId: WORKTREE_ID,
      executionHostId: previousOwner.executionHostId,
      owner: previousOwner
    })
  })

  it('refuses rollback when only the publisher changed after its applied selection', () => {
    const store = createSelectionStore()
    const previous = readActiveWorkspaceSelection()
    store.getState().setActiveWorktree(WORKTREE_ID, appliedOwner.executionHostId, {
      owner: appliedOwner
    })
    const applied = readActiveWorkspaceSelection()
    store.getState().setActiveWorktree(WORKTREE_ID, previousOwner.executionHostId, {
      owner: previousOwner
    })
    const setActiveWorktree = vi.spyOn(store.getState(), 'setActiveWorktree')

    restoreActiveWorkspaceSelection({ previous, applied })

    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(readActiveWorkspaceSelection().owner).toEqual(previousOwner)
  })

  it('preserves publisher navigation while a rejected production create is pending', async () => {
    const store = createSelectionStore()
    const pendingCreate = Promise.withResolvers<never>()
    const runtimeCall = vi.fn(() => pendingCreate.promise)
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })
    const creating = createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: true
    })
    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledOnce())
    const staged = readActiveWorkspaceSelection()

    store.getState().setActiveWorktree(WORKTREE_ID, appliedOwner.executionHostId, {
      owner: appliedOwner
    })
    const setActiveWorktree = vi.spyOn(store.getState(), 'setActiveWorktree')
    pendingCreate.reject(new Error('selector_not_found'))
    const outcome = await creating

    expect(staged.worktreeId).toBe(WORKTREE_ID)
    expect(staged.executionHostId).toBe(RUNTIME_EXECUTION_HOST_ID)
    expect(outcome.status).toBe('failed')
    expect(setActiveWorktree).not.toHaveBeenCalled()
    expect(readActiveWorkspaceSelection()).toEqual({
      worktreeId: WORKTREE_ID,
      executionHostId: appliedOwner.executionHostId,
      owner: appliedOwner
    })
  })
})
