import { expect, it, vi } from 'vitest'
import { openDetectedFilePath } from '../terminal-pane/terminal-file-open-routing'
import { createTerminalLinkTestDoubles } from '../terminal-pane/terminal-link-handlers-test-fixtures'
import {
  flushDoubleRaf,
  installTerminalLinkTestEnvironment
} from '../terminal-pane/terminal-link-handlers-test-harness'
import { nativeChatFileOpenDeps } from './native-chat-link-target-actions'

const doubles = createTerminalLinkTestDoubles()
const { storeState, statMock, openFileMock, openFilePathMock, runtimeEnvironmentCallMock } = doubles

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: vi.fn(() => null) }))

installTerminalLinkTestEnvironment(doubles)

const context = {
  worktreeId: 'wt-feat',
  worktreePath: '/srv/repo',
  runtimeEnvironmentId: 'env-1'
}
const path = '/mnt/data/report.pdf'
const target = { absolutePath: path, line: null, column: null }

it.each([false, true])(
  'refuses a missing chat host file without client access, default-app gesture=%s',
  async (openWithSystemDefault) => {
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'resolve',
      ok: true,
      result: {
        worktree: context.worktreeId,
        relativePath: null,
        absolutePath: path,
        exists: false,
        isDirectory: false
      },
      _meta: { runtimeId: 'remote-runtime' }
    })
    statMock.mockResolvedValue({ isDirectory: false })
    const onOpenFailure = vi.fn()

    openDetectedFilePath(path, null, null, {
      ...nativeChatFileOpenDeps(target, context),
      openWithSystemDefault,
      onOpenFailure
    })
    await flushDoubleRaf()

    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'files.resolveTerminalPath',
        params: { worktree: 'id:wt-feat', pathText: path, crossWorkspace: true }
      })
    )
    expect(statMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(onOpenFailure).toHaveBeenCalledWith({
      verdict: 'missing',
      error: new Error(`File not found on its host: ${path}`)
    })
  }
)
