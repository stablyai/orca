import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getRuntimeGitBlame } from './runtime-git-status-client'

const blame = vi.fn()
const cancelBlame = vi.fn()

const context = {
  settings: { activeRuntimeEnvironmentId: null },
  worktreeId: 'wt-1',
  worktreePath: '/repo'
}

beforeEach(() => {
  blame.mockReset()
  cancelBlame.mockReset()
  cancelBlame.mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { git: { blame, cancelBlame } } })
})

describe('getRuntimeGitBlame cancellation', () => {
  it('does not start a request for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(getRuntimeGitBlame(context, 'file.ts', controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(blame).not.toHaveBeenCalled()
  })

  it('rejects a late local response after cancellation', async () => {
    let resolveBlame: ((result: { ranges: [] }) => void) | undefined
    blame.mockReturnValue(
      new Promise<{ ranges: [] }>((resolve) => {
        resolveBlame = resolve
      })
    )
    const controller = new AbortController()
    const request = getRuntimeGitBlame(context, 'file.ts', controller.signal)

    controller.abort()
    resolveBlame?.({ ranges: [] })

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelBlame).toHaveBeenCalledOnce()
  })
})
