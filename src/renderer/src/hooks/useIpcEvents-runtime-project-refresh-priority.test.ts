import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildStoreState,
  type StoreSubscribeListener
} from './ipc-events-agent-status-store-test-fixtures'
import {
  buildWindowApi,
  stubAuxiliaryModules,
  stubReactSyncEffect
} from './ipc-events-agent-status-window-test-fixtures'
import type * as RuntimeProjectRefreshSchedulerModule from './runtime-project-refresh-scheduler'

describe('useIpcEvents runtime project refresh prioritization', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('reprioritizes queued runtime refreshes when the active workspace owner changes', async () => {
    const request = vi.fn()
    const reprioritize = vi.fn()
    const stop = vi.fn()
    const storeListeners: StoreSubscribeListener[] = []
    let storeState = buildStoreState({
      activeWorktreeId: 'local-worktree',
      activeWorkspaceExecutionHostId: 'local'
    })

    stubReactSyncEffect()
    vi.doMock('../store', () => ({
      useAppStore: {
        subscribe: vi.fn((listener: StoreSubscribeListener) => {
          storeListeners.push(listener)
          return () => {}
        }),
        getState: () => storeState
      }
    }))
    vi.doMock('./runtime-project-refresh-scheduler', async () => {
      const actual = await vi.importActual<typeof RuntimeProjectRefreshSchedulerModule>(
        './runtime-project-refresh-scheduler'
      )
      return {
        ...actual,
        createRuntimeProjectRefreshScheduler: () => ({ request, reprioritize, stop })
      }
    })
    stubAuxiliaryModules()
    vi.stubGlobal('window', buildWindowApi({ onSet: () => () => {} }))

    const { useIpcEvents } = await import('./useIpcEvents')
    useIpcEvents()
    const previousState = storeState
    storeState = {
      ...storeState,
      activeWorktreeId: 'remote-worktree',
      activeWorkspaceExecutionHostId: 'runtime:env-2'
    }
    for (const listener of storeListeners) {
      listener(storeState, previousState)
    }

    expect(reprioritize).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
  })
})
