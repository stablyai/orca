import { describe, expect, it, vi } from 'vitest'
import { openDetectedFilePath } from './terminal-link-handlers'
import type { FileOpenFailure } from './terminal-file-open-routing'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  flushAsyncWork,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, deps, openFileMock, statMock, authorizeExternalPathMock } = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

type OnOpenFailure = (failure: FileOpenFailure) => void

describe('openDetectedFilePath on a path it cannot verify', () => {
  it('reports a verified miss', async () => {
    setPlatform('Macintosh')
    const error = new Error("Error invoking remote method 'fs:stat': Error: ENOENT: no such file")
    statMock.mockRejectedValueOnce(error)
    const onOpenFailure = vi.fn<OnOpenFailure>()

    openDetectedFilePath('/tmp/src/gone.md', null, null, { ...deps, onOpenFailure })
    await flushAsyncWork()

    expect(openFileMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledTimes(1)
    expect(onOpenFailure).toHaveBeenCalledWith({ verdict: 'missing', error })
  })

  it('reports a host that could not answer as unverifiable, not missing', async () => {
    setPlatform('Macintosh')
    const error = new Error('SSH connection closed')
    statMock.mockRejectedValueOnce(error)
    const onOpenFailure = vi.fn<OnOpenFailure>()

    openDetectedFilePath('/tmp/src/present.md', null, null, { ...deps, onOpenFailure })
    await flushAsyncWork()

    expect(onOpenFailure).toHaveBeenCalledTimes(1)
    expect(onOpenFailure.mock.calls[0][0]).toEqual({ verdict: 'unverifiable', error })
  })

  it('reports a refused path authorization as unverifiable', async () => {
    setPlatform('Macintosh')
    const error = new Error('Path is outside the allowed roots')
    authorizeExternalPathMock.mockRejectedValueOnce(error)
    const onOpenFailure = vi.fn<OnOpenFailure>()

    openDetectedFilePath('/tmp/src/denied.md', null, null, { ...deps, onOpenFailure })
    await flushAsyncWork()

    expect(statMock).not.toHaveBeenCalled()
    expect(onOpenFailure.mock.calls[0][0]).toEqual({ verdict: 'unverifiable', error })
  })

  it('skips the callback when a later click superseded the failing one', async () => {
    setPlatform('Macintosh')
    let rejectFirstStat!: (error: Error) => void
    statMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirstStat = reject
        })
    )
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/tmp/src/gone.md', null, null, { ...deps, onOpenFailure })
    await flushAsyncWork()
    openDetectedFilePath('/tmp/src/other.ts', null, null, deps)
    rejectFirstStat(new Error('ENOENT'))
    await flushAsyncWork()

    expect(onOpenFailure).not.toHaveBeenCalled()
  })
})
