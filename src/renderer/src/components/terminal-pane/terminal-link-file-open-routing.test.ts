import { beforeEach, describe, expect, it, vi } from 'vitest'
import { activateAndRevealWorkspace, activateAndRevealWorktree } from '@/lib/worktree-activation'
import { getConnectionId } from '@/lib/connection-context'
import { openDetectedFilePath } from './terminal-link-handlers'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  createDeferred,
  flushAsyncWork,
  flushDoubleRaf,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const findWorkspaceFileRouteMock = vi.hoisted(() => vi.fn())
const showHintMock = vi.hoisted(() => vi.fn())
const doubles = createTerminalLinkTestDoubles()
const {
  storeState,
  deps,
  openFileMock,
  openFilePathMock,
  createBrowserTabMock,
  setPendingEditorRevealMock,
  setMarkdownViewModeMock,
  statMock
} = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

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

vi.mock('./terminal-file-other-workspace-hint', () => ({
  dismissFileInOtherWorkspaceHint: vi.fn(),
  showFileInOtherWorkspaceHint: showHintMock
}))

installTerminalLinkTestEnvironment(doubles)

beforeEach(() => {
  findWorkspaceFileRouteMock.mockReset()
})

describe('handleOscLink', () => {
  it('opens local .html file paths in Orca browser tabs when links route to Orca', async () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: true }

    openDetectedFilePath('/tmp/report.html', null, null, deps)

    // openDetectedFilePath is async (fire-and-forget), so flush the microtask queue
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(openFileMock).not.toHaveBeenCalled()
    expect(setPendingEditorRevealMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'wt-1',
      'file:///tmp/report.html',
      expect.objectContaining({ title: 'report.html', activate: true })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
    // Why: the browser tab is the surface — activation must not re-seed a shell into a
    // workspace whose last terminal the user closed.
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      providesInitialSurface: true
    })
  })

  it('also opens local .htm paths in Orca browser tabs when links route to Orca', async () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: true }

    openDetectedFilePath('/tmp/legacy.HTM', null, null, deps)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(openFileMock).not.toHaveBeenCalled()
    expect(setPendingEditorRevealMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'wt-1',
      'file:///tmp/legacy.HTM',
      expect.objectContaining({ title: 'legacy.HTM' })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('opens local .html file paths in the system browser when links route there', async () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: false }

    openDetectedFilePath('/tmp/report.html', null, null, deps)
    await flushAsyncWork()

    expect(openFilePathMock).toHaveBeenCalledWith('/tmp/report.html', 'local')
    expect(createBrowserTabMock).not.toHaveBeenCalled()

    // Shift takes the other destination, as it does for http links.
    openDetectedFilePath('/tmp/report.html', null, null, { ...deps, openWithSystemDefault: true })
    await flushAsyncWork()

    expect(openFilePathMock).toHaveBeenCalledTimes(1)
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'wt-1',
      'file:///tmp/report.html',
      expect.objectContaining({ title: 'report.html', activate: true })
    )
  })

  it('opens local file paths in Orca and reveals default column 1 with the platform modifier', async () => {
    setPlatform('Macintosh')

    openDetectedFilePath('/tmp/src/main.ts', 42, null, deps)
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/src/main.ts' }),
      { forceContentReload: true }
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filePath: '/tmp/src/main.ts',
        fileId: '/tmp/src/main.ts',
        line: 42,
        column: 1,
        matchLength: 0
      })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
    // Why: the editor file is the surface — the cross-worktree jump must not add a shell.
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('wt-1', {
      providesInitialSurface: true,
      executionHostId: 'local'
    })
  })

  it('opens a sibling folder-workspace file read-only here and names its workspace', async () => {
    const filePath = '/sibling/docs/SKILL.md'
    const owner = {
      worktreeId: 'folder:notes',
      relativePath: 'docs/SKILL.md',
      executionHostId: 'local'
    }
    findWorkspaceFileRouteMock.mockReturnValueOnce(owner)

    openDetectedFilePath(filePath, 12, null, deps)
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(activateAndRevealWorkspace).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('wt-1', {
      providesInitialSurface: true,
      executionHostId: 'local'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath,
        relativePath: filePath,
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        readOnly: true
      }),
      { forceContentReload: true }
    )
    expect(showHintMock).toHaveBeenCalledWith({
      fileId: filePath,
      filePath,
      owner,
      runtimeEnvironmentId: null,
      position: { line: 12, column: null }
    })
  })

  it('opens a direct SSH link to a sibling workspace in that workspace, as before', async () => {
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    findWorkspaceFileRouteMock.mockReturnValue({
      worktreeId: 'wt-2',
      relativePath: 'x.ts',
      executionHostId: 'ssh:ssh-1'
    })

    openDetectedFilePath('/other/x.ts', null, null, deps)
    await flushAsyncWork()

    // Why: a read-only absolute tab on a direct SSH connection would read as this computer's file.
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('wt-2', {
      providesInitialSurface: true,
      executionHostId: 'ssh:ssh-1'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/other/x.ts',
        relativePath: 'x.ts',
        worktreeId: 'wt-2'
      }),
      { forceContentReload: true }
    )
    expect(openFileMock.mock.calls[0][0]).not.toHaveProperty('readOnly')
    expect(showHintMock).not.toHaveBeenCalled()
  })

  it('opens a file outside every workspace here, editable and without a hint', async () => {
    const filePath = '/external/docs/readme.md'

    openDetectedFilePath(filePath, null, null, deps)
    await flushAsyncWork()

    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath, worktreeId: 'wt-1' }),
      { forceContentReload: true }
    )
    expect(openFileMock.mock.calls[0][0]).not.toHaveProperty('readOnly')
    expect(showHintMock).not.toHaveBeenCalled()
  })

  it('preserves explicit column for Orca opens from :line:column links', async () => {
    setPlatform('Macintosh')

    openDetectedFilePath('/tmp/src/main.ts', 42, 7, deps)
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filePath: '/tmp/src/main.ts',
        fileId: '/tmp/src/main.ts',
        line: 42,
        column: 7,
        matchLength: 0
      })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('opens terminal markdown line links in source mode so Monaco can reveal the line', async () => {
    setPlatform('Macintosh')
    const filePath = '/tmp/docs/terminal-scroll-intent-architecture.md'
    const fileId = 'editor:wt-1:runtime-1:terminal-scroll-intent-architecture.md'
    openFileMock.mockImplementationOnce(() => {
      storeState.activeFileIdByWorktree['wt-1'] = fileId
    })

    openDetectedFilePath(filePath, 230, null, deps)
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(setMarkdownViewModeMock).toHaveBeenCalledWith(fileId, 'source')
    expect(setPendingEditorRevealMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filePath,
        fileId,
        line: 230,
        column: 1,
        matchLength: 0
      })
    )
  })

  it('scopes non-Markdown line reveals to the owner-qualified editor tab', async () => {
    setPlatform('Macintosh')
    const filePath = '/tmp/src/main.ts'
    const fileId = 'editor:wt-1:runtime-1:main.ts'
    openFileMock.mockImplementationOnce(() => {
      storeState.activeFileIdByWorktree['wt-1'] = fileId
    })

    openDetectedFilePath(filePath, 42, 7, deps)
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(setMarkdownViewModeMock).not.toHaveBeenCalled()
    expect(setPendingEditorRevealMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filePath,
        fileId,
        line: 42,
        column: 7,
        matchLength: 0
      })
    )
  })

  it('uses the system default app for shift+cmd/ctrl-click file paths', async () => {
    setPlatform('Macintosh')

    openDetectedFilePath('/tmp/src/main.ts', 42, 7, {
      ...deps,
      openWithSystemDefault: true
    })
    await flushAsyncWork()

    expect(openFilePathMock).toHaveBeenCalledWith('/tmp/src/main.ts', 'local')
    expect(openFileMock).not.toHaveBeenCalled()
    expect(setPendingEditorRevealMock).not.toHaveBeenCalled()
  })

  it('falls back to Orca when shift+cmd/ctrl-click system default open fails', async () => {
    setPlatform('Macintosh')
    openFilePathMock.mockResolvedValueOnce(false)

    openDetectedFilePath('/tmp/src/main.ts', 42, 7, {
      ...deps,
      openWithSystemDefault: true
    })
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(openFilePathMock).toHaveBeenCalledWith('/tmp/src/main.ts', 'local')
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/src/main.ts' }),
      { forceContentReload: true }
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filePath: '/tmp/src/main.ts',
        fileId: '/tmp/src/main.ts',
        line: 42,
        column: 7,
        matchLength: 0
      })
    )
  })

  it('cancels a pending Monaco reveal frame when another file open starts', async () => {
    setPlatform('Macintosh')
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 42)
    )
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)

    openDetectedFilePath('/tmp/src/main.ts', 42, null, deps)
    await flushAsyncWork()

    openDetectedFilePath('/tmp/src/other.ts', null, null, deps)

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42)
    expect(setPendingEditorRevealMock).toHaveBeenCalledWith(null)
  })

  it('ignores stale async completion so latest local click wins for Orca open and reveal', async () => {
    setPlatform('Macintosh')
    const firstStat = createDeferred<{ isDirectory: boolean }>()
    const secondStat = createDeferred<{ isDirectory: boolean }>()
    statMock
      .mockImplementationOnce(() => firstStat.promise)
      .mockImplementationOnce(() => secondStat.promise)

    openDetectedFilePath('/tmp/src/first.ts', 10, 2, deps)
    openDetectedFilePath('/tmp/src/second.ts', 20, 3, deps)

    secondStat.resolve({ isDirectory: false })
    await flushAsyncWork()
    await flushDoubleRaf()

    firstStat.resolve({ isDirectory: false })
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledTimes(1)
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/src/second.ts' }),
      { forceContentReload: true }
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        filePath: '/tmp/src/second.ts',
        fileId: '/tmp/src/second.ts',
        line: 20,
        column: 3,
        matchLength: 0
      })
    )
  })
})
