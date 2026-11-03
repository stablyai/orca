import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FeatureInteractionState } from '../../../shared/feature-interactions'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

import {
  installApi,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web before-unload persistence', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('persists final UI and host-partitioned sessions synchronously', async () => {
    const { api, storage } = await installApi('Linux')

    api.app.stageBeforeUnloadSync({
      sessions: [
        { state: { activeWorktreeId: 'local-worktree' } as never },
        {
          state: { activeWorktreeId: 'remote-worktree' } as never,
          hostId: 'runtime:web-env-1'
        }
      ],
      ui: { activeView: 'settings' }
    })

    expect(JSON.parse(storage.getItem('orca.web.workspaceSession.v1') ?? '{}')).toMatchObject({
      activeWorktreeId: 'local-worktree'
    })
    expect(
      JSON.parse(storage.getItem('orca.web.workspaceSession.v1.runtime:web-env-1') ?? '{}')
    ).toMatchObject({ activeWorktreeId: 'remote-worktree' })
    expect(JSON.parse(storage.getItem('orca.web.ui.v1') ?? '{}')).toMatchObject({
      activeView: 'settings'
    })
  })
})

describe('web UI preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('keeps newer feature interaction counts when runtime responses resolve out of order', async () => {
    const pending: ((response: RuntimeRpcResponse<unknown>) => void)[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return new Promise((resolve) => {
            pending.push((response) =>
              resolve({
                ...response,
                id: method,
                _meta: { runtimeId: 'runtime-1' }
              })
            )
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const first = globals.window.api.ui.recordFeatureInteraction('tasks')
    const second = globals.window.api.ui.recordFeatureInteraction('tasks')

    pending[1]({
      id: 'second',
      ok: true,
      result: {
        ui: {
          featureInteractions: {
            tasks: { firstInteractedAt: 100, interactionCount: 2 }
          }
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    await second
    pending[0]({
      id: 'first',
      ok: true,
      result: {
        ui: {
          featureInteractions: {
            tasks: { firstInteractedAt: 100, interactionCount: 1 }
          }
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    await first

    const stored = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as {
      featureInteractions?: FeatureInteractionState
    }
    expect(stored.featureInteractions?.tasks).toEqual({
      firstInteractedAt: 100,
      interactionCount: 2
    })
  })

  it('keeps newer local feature interactions when ui.get returns stale host state', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: {
              ui: {
                featureInteractions: {
                  tasks: { firstInteractedAt: 100, interactionCount: 1 },
                  ports: { firstInteractedAt: 300, interactionCount: 1 }
                }
              }
            },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    globals.storage.setItem(
      'orca.web.ui.v1',
      JSON.stringify({
        featureInteractions: {
          tasks: { firstInteractedAt: 50, interactionCount: 3 }
        }
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const ui = await globals.window.api.ui.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as {
      featureInteractions?: FeatureInteractionState
    }

    expect(ui.featureInteractions?.tasks).toEqual({
      firstInteractedAt: 50,
      interactionCount: 3
    })
    expect(stored.featureInteractions?.tasks).toEqual({
      firstInteractedAt: 50,
      interactionCount: 3
    })
    expect(stored.featureInteractions?.ports).toEqual({
      firstInteractedAt: 300,
      interactionCount: 1
    })
  })
})
