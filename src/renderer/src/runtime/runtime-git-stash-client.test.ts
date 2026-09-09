import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listRuntimeGitStashes } from './runtime-git-stash-client'

const stashList = vi.fn()
const stashCancel = vi.fn()
const context = {
  settings: { activeRuntimeEnvironmentId: null },
  worktreeId: 'wt-1',
  worktreePath: '/repo'
}

beforeEach(() => {
  stashList.mockReset()
  stashCancel.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { git: { stashList, stashCancel } } })
})

describe('runtime stash cancellation', () => {
  it('does not start an already-aborted read', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(listRuntimeGitStashes(context, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(stashList).not.toHaveBeenCalled()
  })

  it('keeps cancellation registered until a late local response settles', async () => {
    let resolveList: ((value: []) => void) | undefined
    stashList.mockReturnValue(
      new Promise<[]>((resolve) => {
        resolveList = resolve
      })
    )
    const controller = new AbortController()
    const request = listRuntimeGitStashes(context, controller.signal)

    controller.abort()
    expect(stashCancel).toHaveBeenCalledOnce()
    resolveList?.([])

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })
})
