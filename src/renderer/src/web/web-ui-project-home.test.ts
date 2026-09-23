import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

const legacyUiUpdate = z.object({
  activeView: z.enum([
    'terminal',
    'settings',
    'tasks',
    'activity',
    'automations',
    'space',
    'skills',
    'artifacts',
    'mobile'
  ]),
  sidebarWidth: z.number()
})

describe('Project home with an older paired host', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it.each(['set', 'setWithAck'] as const)(
    '%s keeps Project home local while preserving sibling updates on the host',
    async (method) => {
      const received: unknown[] = []
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call(name: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
            expect(name).toBe('ui.set')
            received.push(legacyUiUpdate.parse(params))
            return Promise.resolve({
              id: name,
              ok: true,
              result: {},
              _meta: { runtimeId: 'old-host' }
            })
          }
          close(): void {}
        }
      }))
      const globals = installBrowserGlobals('Linux')
      writeStoredRuntimeEnvironment(globals.storage)
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()

      const update = globals.window.api.ui[method]
      if (!update) {
        throw new Error(`${method} is unavailable`)
      }
      await update({ activeView: 'project-home', sidebarWidth: 280 })

      expect(received).toEqual([{ activeView: 'terminal', sidebarWidth: 280 }])
      expect(JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}')).toMatchObject({
        activeView: 'project-home',
        sidebarWidth: 280
      })
    }
  )
})
