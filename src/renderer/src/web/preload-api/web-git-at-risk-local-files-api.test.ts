import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { callAbortableRuntimeEnvironment } from '../../runtime/rpc/calls/abortable-runtime-environment-call'
import { RuntimeRpcCallError } from '../../runtime/rpc/calls/runtime-rpc-result'
import {
  recordRuntimeSubscription,
  stubRuntimeEnvironmentBridge
} from '../../runtime/rpc/testing/runtime-environment-bridge-fixture'

const { resolveWorktreeMock, abortableCallMock } = vi.hoisted(() => ({
  resolveWorktreeMock: vi.fn(),
  abortableCallMock: vi.fn()
}))

vi.mock('./web-runtime-worktree-catalog', () => ({
  resolveRuntimeWorktreeByPath: resolveWorktreeMock,
  resolveRuntimeFilePath: vi.fn()
}))
vi.mock('./web-runtime-session', () => ({
  requireActiveEnvironment: () => ({ id: 'env-1' }),
  updateEnvironmentFromResponse: vi.fn()
}))
vi.mock('../../runtime/rpc/calls/abortable-runtime-environment-call', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callAbortableRuntimeEnvironment: abortableCallMock
}))

import { createWebGitAtRiskLocalFilesApi } from './web-git-at-risk-local-files-api'

const actual = await vi.importActual<{
  callAbortableRuntimeEnvironment: typeof callAbortableRuntimeEnvironment
}>('../../runtime/rpc/calls/abortable-runtime-environment-call')

describe('web git atRiskLocalFiles', () => {
  beforeEach(() => {
    resolveWorktreeMock.mockReset()
    abortableCallMock.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps a cancel that lands during the worktree lookup', async () => {
    const api = createWebGitAtRiskLocalFilesApi()
    let resolveWorktree!: (worktree: { id: string }) => void
    resolveWorktreeMock.mockReturnValue(
      new Promise((resolve) => {
        resolveWorktree = resolve
      })
    )
    let dispatchedSignal: AbortSignal | undefined
    abortableCallMock.mockImplementation(
      (_env: string, _method: string, _params: unknown, _timeout: unknown, signal: AbortSignal) => {
        dispatchedSignal = signal
        return signal.aborted
          ? Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          : Promise.resolve({
              id: '1',
              ok: true,
              result: { count: 0, samplePaths: [], complete: true }
            })
      }
    )

    const scan = api.atRiskLocalFiles({
      worktreePath: '/repo-feature',
      requestToken: 'at-risk-1'
    })
    await api.cancelAtRiskLocalFiles({ requestToken: 'at-risk-1' })
    resolveWorktree({ id: 'wt-1' })

    await expect(scan).rejects.toMatchObject({ name: 'AbortError' })
    // The real call rejects an aborted signal before dispatching any RPC.
    expect(dispatchedSignal?.aborted ?? true).toBe(true)
  })

  it('keeps method_not_found typed so older hosts fall back', async () => {
    const api = createWebGitAtRiskLocalFilesApi()
    resolveWorktreeMock.mockResolvedValue({ id: 'wt-1' })
    abortableCallMock.mockResolvedValue({
      id: '1',
      ok: false,
      error: {
        code: 'method_not_found',
        message: 'Unknown method: git.atRiskLocalFiles'
      }
    })

    const scan = api.atRiskLocalFiles({
      worktreePath: '/repo-feature',
      requestToken: 'at-risk-2'
    })

    await expect(scan).rejects.toBeInstanceOf(RuntimeRpcCallError)
    await expect(scan).rejects.toMatchObject({ code: 'method_not_found' })
  })

  it('rejects a silent connected host at the default 30 s deadline and releases its subscription', async () => {
    vi.useFakeTimers()
    abortableCallMock.mockImplementation(actual.callAbortableRuntimeEnvironment)
    // The host accepts the subscription but never sends a response frame.
    let subscriptionReleased = false
    const host = recordRuntimeSubscription({
      unsubscribe: () => {
        subscriptionReleased = true
      }
    })
    stubRuntimeEnvironmentBridge({
      subscribe: host.subscribe,
      cancelSubscription: vi.fn().mockResolvedValue(undefined)
    })
    resolveWorktreeMock.mockResolvedValue({ id: 'wt-1' })
    const api = createWebGitAtRiskLocalFilesApi()

    let failure: unknown
    void api
      .atRiskLocalFiles({
        worktreePath: '/repo-feature',
        requestToken: 'at-risk-3'
      })
      .catch((error: unknown) => {
        failure = error
      })
    try {
      await vi.advanceTimersByTimeAsync(29_999)
      expect(failure).toBeUndefined()
      expect(subscriptionReleased).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      expect(failure).toBeInstanceOf(Error)
      expect(failure).toMatchObject({
        message: 'Runtime request timed out before git.atRiskLocalFiles completed'
      })
      expect(subscriptionReleased).toBe(true)
    } finally {
      await api.cancelAtRiskLocalFiles({ requestToken: 'at-risk-3' })
    }
  })
})
