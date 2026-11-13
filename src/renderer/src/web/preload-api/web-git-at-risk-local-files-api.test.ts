import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError } from '../../runtime/rpc/calls/runtime-rpc-result'

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

describe('web git atRiskLocalFiles', () => {
  beforeEach(() => {
    resolveWorktreeMock.mockReset()
    abortableCallMock.mockReset()
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
    expect(abortableCallMock).toHaveBeenCalledWith(
      'env-1',
      'git.atRiskLocalFiles',
      { worktree: expect.anything() },
      undefined,
      expect.any(AbortSignal)
    )
  })
})
