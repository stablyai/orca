// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readRuntimeJiraPayload } from './runtime-jira-payload-stream'

type RuntimeEnvironmentSubscribeCallbacks = Parameters<
  typeof window.api.runtimeEnvironments.subscribe
>[1]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readRuntimeJiraPayload', () => {
  it('reassembles chunks and unsubscribes when the stream ends', async () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(
      async (_args: unknown, callbacks: RuntimeEnvironmentSubscribeCallbacks) => {
        callbacks.onResponse({
          id: 'rpc-1',
          ok: true,
          result: { type: 'chunk', content: '{"key":' },
          _meta: { runtimeId: 'runtime-1' }
        })
        callbacks.onResponse({
          id: 'rpc-1',
          ok: true,
          result: { type: 'chunk', content: '"ABC-3"}' },
          _meta: { runtimeId: 'runtime-1' }
        })
        callbacks.onResponse({
          id: 'rpc-1',
          ok: true,
          result: { type: 'end' },
          _meta: { runtimeId: 'runtime-1' }
        })
        return { unsubscribe, sendBinary: vi.fn() }
      }
    )
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })

    await expect(
      readRuntimeJiraPayload<{ key: string }>(
        { kind: 'environment', environmentId: 'env-1' },
        'jira.getIssueStream',
        { key: 'ABC-3' }
      )
    ).resolves.toEqual({ key: 'ABC-3' })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed stream messages', async () => {
    const subscribe = vi.fn(
      async (_args: unknown, callbacks: RuntimeEnvironmentSubscribeCallbacks) => {
        callbacks.onResponse({
          id: 'rpc-1',
          ok: true,
          result: { type: 'unknown' },
          _meta: { runtimeId: 'runtime-1' }
        })
        return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
      }
    )
    vi.stubGlobal('window', { api: { runtimeEnvironments: { subscribe } } })

    await expect(
      readRuntimeJiraPayload(
        { kind: 'environment', environmentId: 'env-1' },
        'jira.getIssueStream',
        { key: 'ABC-3' }
      )
    ).rejects.toThrow('invalid message')
  })
})
