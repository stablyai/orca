import { expect, it, vi } from 'vitest'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import { openDetectedFilePath } from '../../../terminal-pane/links/files/terminal-file-open-routing'
import { createTerminalLinkTestDoubles } from '../../../terminal-pane/links/terminal-link-handlers-test-fixtures'
import {
  flushDoubleRaf,
  installTerminalLinkTestEnvironment
} from '../../../terminal-pane/links/terminal-link-handlers-test-harness'
import {
  nativeChatFileLinkActions,
  nativeChatFileOpenDeps
} from './native-chat-link-target-actions'

const doubles = createTerminalLinkTestDoubles()
const {
  storeState,
  statMock,
  openFileMock,
  openFilePathMock,
  runtimeEnvironmentCallMock,
  revealInExplorerMock
} = doubles

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))
vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

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

it('reveals a folder below a paired workspace in the file explorer', async () => {
  const folderPath = '/srv/repo/docs'
  storeState.activeWorktreeId = context.worktreeId
  runtimeEnvironmentCallMock.mockResolvedValue({
    id: 'resolve',
    ok: true,
    result: {
      worktree: context.worktreeId,
      relativePath: 'docs',
      absolutePath: folderPath,
      exists: true,
      isDirectory: true
    },
    _meta: { runtimeId: 'remote-runtime' }
  })
  openDetectedFilePath(
    folderPath,
    null,
    null,
    nativeChatFileOpenDeps({ absolutePath: folderPath, line: null, column: null }, context)
  )
  await flushDoubleRaf()

  // A folder below the root has no workspace to switch to; it must still reveal visibly.
  expect(revealInExplorerMock).toHaveBeenCalledWith(context.worktreeId, folderPath)
  expect(openFilePathMock).not.toHaveBeenCalled()
})

it('activates the owning worktree before revealing its folder', async () => {
  const folderPath = '/srv/other/docs'
  storeState.activeWorktreeId = context.worktreeId
  vi.mocked(activateAndRevealWorkspace).mockReturnValue({ primaryTabId: null })
  runtimeEnvironmentCallMock.mockResolvedValue({
    id: 'resolve',
    ok: true,
    result: {
      worktree: 'wt-other',
      relativePath: 'docs',
      absolutePath: folderPath,
      exists: true,
      isDirectory: true
    },
    _meta: { runtimeId: 'remote-runtime' }
  })
  openDetectedFilePath(
    folderPath,
    null,
    null,
    nativeChatFileOpenDeps({ absolutePath: folderPath, line: null, column: null }, context)
  )
  await flushDoubleRaf()

  // The explorer only reveals inside the worktree it shows, so the owner must be activated first.
  expect(activateAndRevealWorkspace).toHaveBeenCalledWith('wt-other', {
    executionHostId: 'runtime:env-1'
  })
  expect(revealInExplorerMock).toHaveBeenCalledWith('wt-other', folderPath)
})

it('reports a paired folder outside the workspace instead of revealing it', async () => {
  const folderPath = '/srv/state/chat-scratch/0123456789abcdef0123456789abcdef/docs'
  storeState.activeWorktreeId = context.worktreeId
  runtimeEnvironmentCallMock.mockResolvedValue({
    id: 'stat',
    ok: true,
    result: { isDirectory: true },
    _meta: { runtimeId: 'remote-runtime' }
  })
  const onOpenFailure = vi.fn()
  openDetectedFilePath(folderPath, null, null, {
    ...nativeChatFileOpenDeps({ absolutePath: folderPath, line: null, column: null }, context),
    onOpenFailure
  })
  await flushDoubleRaf()

  // The explorer drops reveals outside its root, so the click must say why instead of going silent.
  expect(revealInExplorerMock).not.toHaveBeenCalled()
  expect(onOpenFailure).toHaveBeenCalledWith({ verdict: 'unavailable' })
})

it('reports a local folder the OS could not open', async () => {
  const folderPath = '/home/me/project/docs'
  const localContext = {
    worktreeId: 'wt-local',
    worktreePath: '/home/me/project',
    runtimeEnvironmentId: null
  }
  storeState.activeWorktreeId = localContext.worktreeId
  statMock.mockResolvedValue({ isDirectory: true })
  openFilePathMock.mockResolvedValue(false)
  const onOpenFailure = vi.fn()
  openDetectedFilePath(folderPath, null, null, {
    ...nativeChatFileOpenDeps({ absolutePath: folderPath, line: null, column: null }, localContext),
    onOpenFailure
  })
  await flushDoubleRaf()

  expect(openFilePathMock).toHaveBeenCalledWith(folderPath, 'local')
  expect(onOpenFailure).toHaveBeenCalledWith({ verdict: 'unavailable' })
})

it('labels a trailing-separator folder link as Open folder', () => {
  const actions = nativeChatFileLinkActions(
    { absolutePath: '/srv/repo/docs', line: null, column: null, isDirectoryHint: true },
    context
  )
  expect(actions.primary.label).toBe('Open folder')
})
