import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import { recordRuntimeSubscription } from '@/runtime/rpc/testing/runtime-environment-bridge-fixture'
import {
  createTestStore,
  githubSourceContext,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentSubscribe
} from '../github-slice-test-harness'

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RPC check-details envelope safety', () => {
  it('drops secret fields retained by the actual RPC failure envelope', async () => {
    const subscription = recordRuntimeSubscription()
    runtimeEnvironmentSubscribe.mockImplementation(subscription.subscribe)
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'focused-env' }),
      repos: [
        {
          id: 'caller-repo',
          path: '/folder',
          displayName: 'Folder',
          badgeColor: '',
          addedAt: 1,
          kind: 'folder'
        }
      ]
    })
    const request = store.getState().fetchPRCheckDetails(
      '/folder',
      {
        checkRunId: 123,
        workflowRunId: 456,
        checkName: 'fork-build',
        url: 'https://github.example.com/fork/widgets/actions/runs/456',
        prRepo: { owner: 'Fork', repo: 'Widgets', host: 'github.example.com' }
      },
      {
        repoId: 'caller-repo',
        sourceContext: githubSourceContext('runtime:source-env', 'source-repo-id')
      }
    )
    const settlement = Promise.allSettled([request])
    await vi.advanceTimersByTimeAsync(0)
    const response = {
      id: 'SYNTHETIC_SECRET_id',
      ok: false,
      error: {
        code: 'SYNTHETIC_SECRET_code',
        message: 'SYNTHETIC_SECRET_message',
        data: Object.assign(new Error('SYNTHETIC_SECRET_message'), {
          stack: 'SYNTHETIC_SECRET_stack',
          stdout: 'SYNTHETIC_SECRET_stdout',
          stderr: 'SYNTHETIC_SECRET_stderr',
          cause: { message: 'SYNTHETIC_SECRET_cause' },
          response: { error: { message: 'SYNTHETIC_SECRET_rpc' } },
          arbitrary: 'SYNTHETIC_SECRET_property'
        })
      },
      _meta: { runtimeId: 'SYNTHETIC_SECRET_runtime' }
    }
    subscription.respond(response)
    const [result] = await settlement
    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected' || !(result.reason instanceof Error)) {
      throw new Error('Expected a rejected Error')
    }
    expect(result.reason.message).not.toContain('SYNTHETIC_SECRET')
    expect(result.reason.stack).not.toContain('SYNTHETIC_SECRET')
    expect(JSON.stringify(result.reason)).not.toContain('SYNTHETIC_SECRET')
    expect(JSON.stringify(store.getState())).not.toContain('SYNTHETIC_SECRET')
  })
})
