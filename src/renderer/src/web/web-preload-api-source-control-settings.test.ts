import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web settings preload API source control settings', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps browser-local source control settings when a paired runtime reply carries only launch recipes', async () => {
    const hostRecipes = { actions: { fixChecks: { agentId: 'codex' } } }
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: 'call-1',
            ok: true,
            result: { settings: { compactWorktreeCards: true, sourceControlAi: hostRecipes } },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))
    const customActions = [
      { id: 'review', label: 'Review', commandInputTemplate: '/code-review {prUrl}' }
    ]
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({
        sourceControlAi: {
          enabled: true,
          customActions,
          actions: { commitMessage: { commandInputTemplate: 'Local commit recipe' } }
        }
      })
    )
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.set({ compactWorktreeCards: true })

    expect(settings.sourceControlAi?.customActions).toEqual(customActions)
    expect(settings.sourceControlAi?.enabled).toBe(true)
    expect(settings.sourceControlAi?.actions).toEqual({
      commitMessage: { commandInputTemplate: 'Local commit recipe' },
      ...hostRecipes.actions
    })
  }, 15_000)
})
