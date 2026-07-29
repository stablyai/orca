import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openOsRequestedFileMock } = vi.hoisted(() => ({ openOsRequestedFileMock: vi.fn() }))

vi.mock('@/lib/open-os-requested-file', () => ({
  openOsRequestedFile: openOsRequestedFileMock
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, value: string) => value
}))

import { toast } from 'sonner'
import { pullPendingOsRequestedFiles } from './use-os-requested-file-opening'

beforeEach(() => {
  openOsRequestedFileMock.mockReset()
  vi.mocked(toast.error).mockClear()
})

function stubPendingPaths(paths: string[]): void {
  globalThis.window = { api: { osFileOpen: { takePending: vi.fn(async () => paths) } } } as never
}

describe('pullPendingOsRequestedFiles', () => {
  it('does not propagate a rejection from a single bad path', async () => {
    stubPendingPaths(['/Users/x/projects/a.md'])
    openOsRequestedFileMock.mockRejectedValueOnce(new Error('boom'))

    await expect(pullPendingOsRequestedFiles(() => false)).resolves.toBeUndefined()
    expect(toast.error).toHaveBeenCalledTimes(1)
  })

  it('still opens the remaining paths after the first one fails', async () => {
    stubPendingPaths(['/Users/x/projects/a.md', '/Users/x/projects/b.md', '/Users/x/projects/c.md'])
    openOsRequestedFileMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)

    await pullPendingOsRequestedFiles(() => false)

    expect(openOsRequestedFileMock).toHaveBeenCalledTimes(3)
    expect(openOsRequestedFileMock).toHaveBeenNthCalledWith(1, '/Users/x/projects/a.md')
    expect(openOsRequestedFileMock).toHaveBeenNthCalledWith(2, '/Users/x/projects/b.md')
    expect(openOsRequestedFileMock).toHaveBeenNthCalledWith(3, '/Users/x/projects/c.md')
  })

  it('stops opening remaining paths once cancellation is reported mid-batch', async () => {
    stubPendingPaths(['/Users/x/projects/a.md', '/Users/x/projects/b.md'])
    let cancelled = false
    openOsRequestedFileMock.mockImplementationOnce(async () => {
      // Why: simulates unmount happening during the first path's async open.
      cancelled = true
    })

    await pullPendingOsRequestedFiles(() => cancelled)

    expect(openOsRequestedFileMock).toHaveBeenCalledTimes(1)
    expect(openOsRequestedFileMock).toHaveBeenCalledWith('/Users/x/projects/a.md')
  })
})
