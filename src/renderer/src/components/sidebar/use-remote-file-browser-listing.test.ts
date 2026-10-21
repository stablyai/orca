// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  browseRuntimeSshDirectory: vi.fn(),
  browseRuntimeServerDirectory: vi.fn(),
  browseDir: vi.fn()
}))

vi.mock('@/runtime/runtime-ssh-target-management', () => ({
  browseRuntimeSshDirectory: mocks.browseRuntimeSshDirectory
}))
vi.mock('@/runtime/runtime-server-directory-browser', () => ({
  browseRuntimeServerDirectory: mocks.browseRuntimeServerDirectory
}))

const { useRemoteFileBrowserListing } = await import('./use-remote-file-browser-listing')

const listing = { resolvedPath: '/home/me', entries: [], pathFlavor: 'posix' as const }

describe('remote folder listing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(window, { api: { ssh: { browseDir: mocks.browseDir } } })
    for (const mock of Object.values(mocks)) {
      mock.mockResolvedValue(listing)
    }
  })

  it("asks the server to list its own SSH host's folders", async () => {
    const { result } = renderHook(() => useRemoteFileBrowserListing('ssh-p8', 'env-1'))

    await result.current.fetchListing('~')

    expect(mocks.browseRuntimeSshDirectory).toHaveBeenCalledWith('env-1', 'ssh-p8', '~')
    expect(mocks.browseDir).not.toHaveBeenCalled()
    expect(mocks.browseRuntimeServerDirectory).not.toHaveBeenCalled()
  })

  it("lists this client's SSH host and the server's own disk as before", async () => {
    await renderHook(() =>
      useRemoteFileBrowserListing('ssh-mine', undefined)
    ).result.current.fetchListing('~')
    await renderHook(() =>
      useRemoteFileBrowserListing(undefined, 'env-1')
    ).result.current.fetchListing('~')

    expect(mocks.browseDir).toHaveBeenCalledWith({ targetId: 'ssh-mine', dirPath: '~' })
    expect(mocks.browseRuntimeServerDirectory).toHaveBeenCalledWith('env-1', '~')
    expect(mocks.browseRuntimeSshDirectory).not.toHaveBeenCalled()
  })
})
