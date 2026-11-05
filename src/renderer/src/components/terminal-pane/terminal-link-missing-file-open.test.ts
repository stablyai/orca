import { describe, expect, it, vi } from 'vitest'
import { openDetectedFilePath } from './terminal-link-handlers'

import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  flushAsyncWork,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, deps, statMock } = doubles

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

describe('openDetectedFilePath on a path it cannot verify', () => {
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
