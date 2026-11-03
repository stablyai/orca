import { GITHUB_EXACT_DETAILS_READ_INTENT_RUNTIME_CAPABILITY } from '../../../shared/task-source-runtime-capabilities'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY } from '../../../shared/source-control-runtime-capabilities'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  RUNTIME_PROTOCOL_VERSION,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
} from '../../../shared/protocol-version'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web GitHub preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('keeps ordinary false and explicit Refresh true through the installed browser adapter', async () => {
    const calls: { method: string; params: unknown }[] = []
    const details = {
      item: {
        id: 'issue:7',
        number: 7,
        type: 'issue',
        title: 'Fork',
        url: 'https://github.com/fork/orca/issues/7',
        state: 'open',
        labels: [],
        author: null,
        updatedAt: ''
      },
      body: 'Full details',
      comments: []
    }
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          calls.push({ method, params })
          return Promise.resolve({
            id: `call-${calls.length}`,
            ok: true,
            result:
              method === 'status.get'
                ? {
                    runtimeId: 'runtime-1',
                    graphStatus: 'ready',
                    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
                    minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
                    capabilities: [
                      GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY,
                      GITHUB_EXACT_DETAILS_READ_INTENT_RUNTIME_CAPABILITY
                    ]
                  }
                : details,
            _meta: { runtimeId: 'runtime-1' }
          })
        }
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const args = {
      repoPath: '/clone',
      number: 7,
      type: 'issue' as const,
      ownerRepo: { owner: 'fork', repo: 'orca', host: 'github.com' }
    }
    await expect(globals.window.api.gh.workItemDetails(args)).resolves.toEqual(details)
    await expect(
      globals.window.api.gh.workItemDetails({ ...args, canonical: true })
    ).resolves.toEqual(details)
    expect(calls.filter((call) => call.method === 'github.workItemDetails')).toEqual([
      { method: 'github.workItemDetails', params: { ...args, repo: '/clone', canonical: false } },
      { method: 'github.workItemDetails', params: { ...args, repo: '/clone', canonical: true } }
    ])
  })
})
