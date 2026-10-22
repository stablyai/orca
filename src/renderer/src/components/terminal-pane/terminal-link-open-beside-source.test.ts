import { describe, expect, it, vi } from 'vitest'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { openDetectedFilePath } from './terminal-link-handlers'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  createDeferred,
  flushAsyncWork,
  flushDoubleRaf,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'
import type { PendingEditorReveal } from '@/store/slices/editor/types/pending-editor-reveal'

const findWorkspaceFileRouteMock = vi.hoisted(() => vi.fn())
const toastErrorMock = vi.hoisted(() => vi.fn())
const doubles = createTerminalLinkTestDoubles()
const {
  storeState,
  deps,
  openFileForLinkMock,
  createBrowserTabMock,
  openFilePathMock,
  setPendingEditorRevealMock,
  statMock
} = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: findWorkspaceFileRouteMock
}))

installTerminalLinkTestEnvironment(doubles)

function seedSourceTab(): void {
  storeState.groupsByWorktree = {
    'wt-1': [
      { id: 'group-a', worktreeId: 'wt-1', activeTabId: 'unified-term', tabOrder: ['unified-term'] }
    ]
  }
  storeState.unifiedTabsByWorktree = {
    'wt-1': [
      { id: 'unified-term', entityId: 'term-1', groupId: 'group-a', contentType: 'terminal' }
    ]
  }
}

const sourceDeps = { ...deps, sourceTabId: 'term-1' }

function lastReveal(): PendingEditorReveal {
  return setPendingEditorRevealMock.mock.calls.at(-1)?.[0]
}

describe('terminal file links carry their source tab', () => {
  it('captures the source tab at activation and passes it to the open', async () => {
    setPlatform('Macintosh')
    seedSourceTab()
    const stat = createDeferred<{ isDirectory: boolean }>()
    statMock.mockImplementationOnce(() => stat.promise)

    openDetectedFilePath('/tmp/src/a.ts', null, null, sourceDeps)
    // Why: a move after the click changes where ranking starts, not which tab was captured.
    storeState.unifiedTabsByWorktree = {}
    stat.resolve({ isDirectory: false })
    await flushAsyncWork()

    expect(openFileForLinkMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/src/a.ts', worktreeId: 'wt-1' }),
      { forceContentReload: true },
      { sourceTabId: 'unified-term', workspaceId: 'wt-1', hostId: null },
      expect.any(Function)
    )
  })

  it('pins an explicit request to the source group', async () => {
    setPlatform('Macintosh')
    seedSourceTab()

    openDetectedFilePath('/tmp/src/a.ts', null, null, { ...sourceDeps, openInSourceGroup: true })
    await flushAsyncWork()

    expect(openFileForLinkMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        workspaceId: 'wt-1',
        hostId: null,
        targetGroupId: 'group-a'
      }),
      expect.any(Function)
    )
  })

  it('opens HTML source in the explicitly requested source group', async () => {
    setPlatform('Macintosh')
    seedSourceTab()

    openDetectedFilePath('/tmp/report.html', null, null, { ...sourceDeps, openInSourceGroup: true })
    await flushAsyncWork()

    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(openFileForLinkMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/report.html', language: 'html', mode: 'edit' }),
      { forceContentReload: true },
      expect.objectContaining({
        workspaceId: 'wt-1',
        hostId: null,
        targetGroupId: 'group-a'
      }),
      expect.any(Function)
    )
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('refuses a closed explicit group before activating its workspace', async () => {
    setPlatform('Macintosh')
    seedSourceTab()
    const stat = createDeferred<{ isDirectory: boolean }>()
    statMock.mockImplementationOnce(() => stat.promise)

    openDetectedFilePath('/tmp/src/a.ts', null, null, { ...sourceDeps, openInSourceGroup: true })
    storeState.groupsByWorktree = {}
    stat.resolve({ isDirectory: false })
    await flushAsyncWork()

    expect(activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(openFileForLinkMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
  })

  it('checks the resolved host even when no sibling-workspace route is needed', async () => {
    setPlatform('Macintosh')
    seedSourceTab()
    storeState.unifiedTabsByWorktree['wt-1'][0].executionHostId = 'ssh:other-host'

    openDetectedFilePath('/tmp/src/a.ts', null, null, { ...sourceDeps, openInSourceGroup: true })
    await flushAsyncWork()

    expect(activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(openFileForLinkMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
  })

  it('refuses an explicit request that resolves to a directory', async () => {
    setPlatform('Macintosh')
    seedSourceTab()
    statMock.mockResolvedValueOnce({ isDirectory: true })

    openDetectedFilePath('/tmp/src', null, null, { ...sourceDeps, openInSourceGroup: true })
    await flushAsyncWork()

    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileForLinkMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
  })

  it('refuses an explicit request routed to another workspace before activating it', async () => {
    setPlatform('Macintosh')
    seedSourceTab()
    storeState.openFiles = [{ filePath: '/other/x.ts', worktreeId: 'wt-2' }]
    findWorkspaceFileRouteMock.mockReturnValueOnce({
      worktreeId: 'wt-2',
      executionHostId: 'local',
      relativePath: 'x.ts'
    })

    openDetectedFilePath('/other/x.ts', null, null, { ...sourceDeps, openInSourceGroup: true })
    await flushAsyncWork()

    expect(activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(openFileForLinkMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
  })

  it('keeps automatic HTML opens on their existing browser route', async () => {
    setPlatform('Macintosh')
    seedSourceTab()

    openDetectedFilePath('/tmp/report.html', null, null, sourceDeps)
    await flushAsyncWork()

    expect(createBrowserTabMock).toHaveBeenCalledTimes(1)
    expect(toastErrorMock).not.toHaveBeenCalled()
  })
})

describe('terminal file link reveals target the opened view', () => {
  it('scopes the reveal to the returned view', async () => {
    setPlatform('Macintosh')

    openDetectedFilePath('/tmp/src/a.ts', 12, 3, deps)
    await flushAsyncWork()
    await flushDoubleRaf()

    const reveal = lastReveal()
    expect(reveal).toMatchObject({
      fileId: '/tmp/src/a.ts',
      viewStateId: 'view:/tmp/src/a.ts',
      line: 12,
      column: 3
    })
    expect(reveal.canApply?.()).toBe(true)
  })

  it('invalidates a published reveal when a newer click has no line', async () => {
    setPlatform('Macintosh')

    openDetectedFilePath('/tmp/src/a.ts', 12, 3, deps)
    await flushAsyncWork()
    await flushDoubleRaf()
    const reveal = lastReveal()

    openDetectedFilePath('/tmp/src/b.ts', null, null, deps)

    expect(reveal.canApply?.()).toBe(false)
  })

  it('invalidates a reveal whose view closed before the editor consumed it', async () => {
    setPlatform('Macintosh')

    openDetectedFilePath('/tmp/src/a.ts', 12, 3, deps)
    await flushAsyncWork()
    await flushDoubleRaf()
    const reveal = lastReveal()

    storeState.unifiedTabsByWorktree = { 'wt-1': [] }

    expect(reveal.canApply?.()).toBe(false)
  })

  it('skips the reveal when the open was refused', async () => {
    setPlatform('Macintosh')
    openFileForLinkMock.mockReturnValueOnce(null)

    openDetectedFilePath('/tmp/src/a.ts', 12, 3, deps)
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(setPendingEditorRevealMock).not.toHaveBeenCalled()
  })
})
