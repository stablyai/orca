import { openRoutedHttpLink } from '@/lib/browser/navigation/http-link-destinations'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import './files/terminal-link-handlers'
import { openDetectedFilePath } from './files/terminal-file-open-routing'
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
  setPendingEditorRevealMock,
  statMock
} = doubles

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: () => 'plaintext'
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
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

  it('reports a refused HTML placement for the internal Open in new tab action', async () => {
    seedSourceTab()
    const stat = createDeferred<{ isDirectory: boolean }>()
    statMock.mockImplementationOnce(() => stat.promise)

    openDetectedFilePath('/tmp/report.html', null, null, {
      ...sourceDeps,
      openInSourceGroupSurface: 'internal'
    })
    storeState.groupsByWorktree = {}
    stat.resolve({ isDirectory: false })
    await flushAsyncWork()

    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(openFileForLinkMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledExactlyOnceWith(
      "Couldn't open /tmp/report.html in this group"
    )
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
})

describe('terminal file link reveals target the opened view', () => {
  afterEach(() => vi.restoreAllMocks())

  it('invalidates an editor line reveal when a browser link is activated', async () => {
    setPlatform('Macintosh')
    openDetectedFilePath('/tmp/src/a.ts', 12, 3, deps)
    await flushAsyncWork()
    await flushDoubleRaf()
    const reveal = lastReveal()
    openRoutedHttpLink('https://example.com/', { worktreeId: 'wt-1', forceDestination: 'orca' })
    expect(reveal.canApply?.()).toBe(false)
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
})
