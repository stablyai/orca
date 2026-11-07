// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readRuntimeJiraPayload } from './runtime-jira-payload-stream'
import { stubRuntimeEnvironmentBridge } from '../rpc/testing/runtime-environment-bridge-fixture'

type RuntimeEnvironmentSubscribeCallbacks = Parameters<
  typeof window.api.runtimeEnvironments.subscribe
>[1]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readRuntimeJiraPayload', () => {
  it('reassembles JSON chunks when the stream ends', async () => {
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
    stubRuntimeEnvironmentBridge({ subscribe })

    await expect(
      readRuntimeJiraPayload<{ key: string }>(
        { kind: 'environment', environmentId: 'env-1' },
        'jira.getIssueStream',
        { key: 'ABC-3' }
      )
    ).resolves.toEqual({ key: 'ABC-3' })
  })
})
