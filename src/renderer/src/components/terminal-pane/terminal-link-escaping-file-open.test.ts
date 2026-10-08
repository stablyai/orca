import { describe, expect, it, vi } from 'vitest'
import { openDetectedFilePath } from './terminal-link-handlers'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  flushAsyncWork,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, deps, openFileMock, statMock } = doubles

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

/** Main's answer for a project link to outside: refused inside the root, readable as user-named. */
function linkLeadsOutOfProject(): void {
  statMock.mockImplementation(async ({ access }: { access?: { kind: string } }) => {
    if (access?.kind !== 'user-file') {
      throw new Error('Access denied: path resolves outside allowed directories')
    }
    return { size: 1, isDirectory: false, mtime: 1 }
  })
}

describe('Cmd-click on a project file that links out of the project', () => {
  it('opens it by its absolute path so it reads the same after a restart', async () => {
    setPlatform('Macintosh')
    linkLeadsOutOfProject()

    openDetectedFilePath('/tmp/docs/link.md', null, null, deps)
    await flushAsyncWork()

    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/docs/link.md',
        relativePath: '/tmp/docs/link.md',
        worktreeId: 'wt-1'
      }),
      expect.anything()
    )
  })

  it('keeps an ordinary project file as a project tab', async () => {
    setPlatform('Macintosh')
    statMock.mockReset().mockResolvedValue({ size: 1, isDirectory: false, mtime: 1 })

    openDetectedFilePath('/tmp/docs/plain.md', null, null, deps)
    await flushAsyncWork()

    expect(statMock).toHaveBeenCalledExactlyOnceWith({
      filePath: '/tmp/docs/plain.md',
      connectionId: undefined
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/docs/plain.md', relativePath: 'docs/plain.md' }),
      expect.anything()
    )
  })
})
