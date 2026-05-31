/* eslint-disable max-lines -- Why: terminal link routing has intertwined local,
SSH, and runtime cases; keeping them in one suite prevents fixture drift. */
import type { IDisposable, ILink } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  createFilePathLinkProvider,
  getTerminalFileOpenHint,
  getTerminalHtmlFileOpenHint,
  installFilePathLinkClickFallback,
  isTerminalLinkActivation,
  openFilePathLinkAtBufferPosition,
  openDetectedFilePath
} from './terminal-link-handlers'
import { TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES } from './terminal-path-exists-cache'
import { handleOscLink } from './terminal-osc-link-routing'
import { installHttpLinkClickFallback } from './terminal-url-link-hit-testing'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { getConnectionId } from '@/lib/connection-context'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

const openUrlMock = vi.fn()
const openFileUriMock = vi.fn()
const openFilePathMock = vi.fn()
const openFileMock = vi.fn()
const authorizeExternalPathMock = vi.fn()
const statMock = vi.fn().mockResolvedValue({ isDirectory: false })
const runtimeEnvironmentCallMock = vi.fn()
const runtimeEnvironmentTransportCallMock = vi.fn()
const setActiveWorktreeMock = vi.fn()
const createBrowserTabMock = vi.fn()
const setPendingEditorRevealMock = vi.fn()

const deps = { worktreeId: 'wt-1', worktreePath: '/tmp' }
const storeState = {
  settings: undefined as
    | { openLinksInApp?: boolean; activeRuntimeEnvironmentId?: string | null }
    | undefined,
  setActiveWorktree: setActiveWorktreeMock,
  createBrowserTab: createBrowserTabMock,
  openFile: openFileMock,
  setPendingEditorReveal: setPendingEditorRevealMock
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: () => 'plaintext'
}))

// Why: the real helper reads worktreesByRepo/activeRepoId/etc. from the store
// and orchestrates side effects that are out of scope for the link-handler
// unit tests. Mock it so these tests only assert on routing (browser tab vs.
// openFile), not on activation internals.
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

function setPlatform(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function flushDoubleRaf(): Promise<void> {
  await flushAsyncWork()
  await flushAsyncWork()
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  runtimeEnvironmentTransportCallMock.mockReset()
  runtimeEnvironmentTransportCallMock.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCallMock(args)
  })
  vi.mocked(getConnectionId).mockReturnValue(null)
  openFilePathMock.mockResolvedValue(true)
  storeState.settings = undefined
  registerHttpLinkStoreAccessor(() => storeState)
  vi.stubGlobal('window', {
    dispatchEvent: vi.fn(),
    api: {
      shell: {
        openUrl: openUrlMock,
        openFileUri: openFileUriMock,
        openFilePath: openFilePathMock,
        pathExists: vi.fn().mockResolvedValue(true)
      },
      fs: {
        authorizeExternalPath: authorizeExternalPathMock,
        stat: statMock
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCallMock }
    }
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    return setTimeout(() => callback(0), 0) as unknown as number
  })
  vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
    clearTimeout(handle)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isTerminalLinkActivation', () => {
  it('requires cmd on macOS', () => {
    setPlatform('Macintosh')

    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false })).toBe(true)
    expect(isTerminalLinkActivation({ metaKey: false, ctrlKey: true })).toBe(false)
    expect(isTerminalLinkActivation(undefined)).toBe(false)
  })

  it('requires ctrl on non-macOS platforms', () => {
    setPlatform('Windows')

    expect(isTerminalLinkActivation({ metaKey: false, ctrlKey: true })).toBe(true)
    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false })).toBe(false)
    expect(isTerminalLinkActivation(undefined)).toBe(false)
  })
})

describe('handleOscLink', () => {
  it('ignores http links without the platform modifier', () => {
    setPlatform('Macintosh')

    handleOscLink('https://example.com', { metaKey: false, ctrlKey: false }, deps)
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('routes to the system browser when openLinksInApp is off', () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: false }
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    handleOscLink(
      'https://example.com',
      { metaKey: true, ctrlKey: false, shiftKey: false, preventDefault, stopPropagation },
      deps
    )

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(preventDefault).toHaveBeenCalled()
    // Why: we intentionally do NOT stopPropagation — xterm's SelectionService
    // relies on the mouseup bubbling to ownerDocument to detach its drag-select
    // mousemove listener. Stopping propagation was causing phantom selections
    // after Cmd+clicking a link and then moving the mouse back over the terminal.
    expect(stopPropagation).not.toHaveBeenCalled()
  })

  it('defaults to Orca when settings have not hydrated yet', () => {
    setPlatform('Macintosh')
    storeState.settings = undefined

    handleOscLink('https://example.com', { metaKey: true, ctrlKey: false, shiftKey: false }, deps)

    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', 'https://example.com/', {
      activate: true
    })
    expect(setActiveWorktreeMock).toHaveBeenCalledWith('wt-1')
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('uses the system browser for shift+cmd/ctrl+click even when Orca browser tabs are enabled', () => {
    setPlatform('Windows')
    storeState.settings = { openLinksInApp: true }

    handleOscLink('https://example.com', { metaKey: false, ctrlKey: true, shiftKey: true }, deps)

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('falls back to the system browser when no worktree owns the terminal pane', () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: true }

    handleOscLink(
      'https://example.com',
      { metaKey: true, ctrlKey: false, shiftKey: false },
      { worktreeId: '', worktreePath: '/tmp' }
    )

    expect(openUrlMock).toHaveBeenCalledWith('https://example.com/')
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('opens local .html file paths in Orca browser tabs with the platform modifier', async () => {
    setPlatform('Macintosh')

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
  })

  it('also opens local .htm paths in Orca browser tabs with the platform modifier', async () => {
    setPlatform('Macintosh')

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

  it('opens local file paths in Orca and reveals default column 1 with the platform modifier', async () => {
    setPlatform('Macintosh')

    openDetectedFilePath('/tmp/src/main.ts', 42, null, deps)
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/src/main.ts' })
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '/tmp/src/main.ts',
      line: 42,
      column: 1,
      matchLength: 0
    })
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('preserves explicit column for Orca opens from :line:column links', async () => {
    setPlatform('Macintosh')

    openDetectedFilePath('/tmp/src/main.ts', 42, 7, deps)
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '/tmp/src/main.ts',
      line: 42,
      column: 7,
      matchLength: 0
    })
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('uses the system default app for shift+cmd/ctrl-click file paths', async () => {
    setPlatform('Macintosh')

    openDetectedFilePath('/tmp/src/main.ts', 42, 7, {
      ...deps,
      openWithSystemDefault: true
    })
    await flushAsyncWork()

    expect(openFilePathMock).toHaveBeenCalledWith('/tmp/src/main.ts')
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

    expect(openFilePathMock).toHaveBeenCalledWith('/tmp/src/main.ts')
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/src/main.ts' })
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '/tmp/src/main.ts',
      line: 42,
      column: 7,
      matchLength: 0
    })
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

  it('advertises the system default open behavior in hover hints', () => {
    setPlatform('Macintosh')
    expect(getTerminalFileOpenHint()).toBe('⌘+click to open or ⇧⌘+click for default app')
    expect(getTerminalHtmlFileOpenHint()).toBe('⌘+click to open or ⇧⌘+click for default browser')

    setPlatform('Windows')
    expect(getTerminalFileOpenHint()).toBe('Ctrl+click to open or Shift+Ctrl+click for default app')
    expect(getTerminalHtmlFileOpenHint()).toBe(
      'Ctrl+click to open or Shift+Ctrl+click for default browser'
    )
  })

  it('opens local file URL links in Orca when the platform modifier is pressed', async () => {
    setPlatform('Windows')

    handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: false }, deps)
    // Without modifier, nothing happens
    expect(openFilePathMock).not.toHaveBeenCalled()

    handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: true }, deps)

    // openDetectedFilePath is async (fire-and-forget), so flush the microtask queue
    // before asserting on positive behavior.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: '/tmp/test.txt' })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/test.txt' })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('opens Windows absolute OSC link targets that parse as URL schemes', async () => {
    setPlatform('Windows')

    handleOscLink(
      'C:\\repo\\src\\index.ts:12:3',
      { metaKey: false, ctrlKey: true },
      {
        ...deps,
        startupCwd: 'C:\\repo',
        worktreePath: 'C:\\repo'
      }
    )
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: 'C:/repo/src/index.ts'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'C:/repo/src/index.ts' })
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: 'C:/repo/src/index.ts',
      line: 12,
      column: 3,
      matchLength: 0
    })
  })

  it('opens Windows UNC file URL links from Windows worktrees', async () => {
    setPlatform('Windows')

    handleOscLink(
      'file://server/share/repo/test.txt',
      { metaKey: false, ctrlKey: true },
      {
        ...deps,
        worktreePath: '\\\\server\\share\\repo'
      }
    )
    await flushAsyncWork()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: '//server/share/repo/test.txt'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '//server/share/repo/test.txt' })
    )
  })

  it('rejects hosted file URL links when the active worktree is not Windows-local', async () => {
    setPlatform('Windows')

    handleOscLink(
      'file://server/share/repo/test.txt',
      { metaKey: false, ctrlKey: true },
      {
        ...deps,
        worktreePath: '/home/user/repo'
      }
    )
    await flushAsyncWork()

    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('opens #L file URL links in Orca and preserves anchors', async () => {
    setPlatform('Macintosh')

    handleOscLink('file:///tmp/test.txt#L42', { metaKey: true, ctrlKey: false }, deps)
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: '/tmp/test.txt' })
    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/test.txt' })
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '/tmp/test.txt',
      line: 42,
      column: 1,
      matchLength: 0
    })
  })

  it('opens file URL links with the system default app for shift+cmd/ctrl-click', async () => {
    setPlatform('Macintosh')

    handleOscLink(
      'file:///tmp/test.txt#L42',
      { metaKey: true, ctrlKey: false, shiftKey: true },
      deps
    )
    await flushAsyncWork()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: '/tmp/test.txt' })
    expect(openFilePathMock).toHaveBeenCalledWith('/tmp/test.txt')
    expect(openFileMock).not.toHaveBeenCalled()
    expect(setPendingEditorRevealMock).not.toHaveBeenCalled()
  })

  it('preserves trailing line and column suffixes when shift+cmd/ctrl-click native open falls back', async () => {
    setPlatform('Macintosh')
    openFilePathMock.mockResolvedValueOnce(false)

    handleOscLink(
      'file:///tmp/test.txt:42:7',
      { metaKey: true, ctrlKey: false, shiftKey: true },
      deps
    )
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: '/tmp/test.txt' })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/test.txt' })
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '/tmp/test.txt',
      line: 42,
      column: 7,
      matchLength: 0
    })
  })

  it('opens UNC file URL links with line and column anchors', async () => {
    setPlatform('Windows')

    handleOscLink(
      'file://Server/Share/Repo/src/app.ts#L12C3',
      { metaKey: false, ctrlKey: true },
      {
        ...deps,
        worktreePath: '//Server/Share/Repo'
      }
    )
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: '//server/Share/Repo/src/app.ts'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '//server/Share/Repo/src/app.ts',
        relativePath: 'src/app.ts'
      })
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '//server/Share/Repo/src/app.ts',
      line: 12,
      column: 3,
      matchLength: 0
    })
  })

  it('opens relative OSC file links against the terminal cwd', async () => {
    setPlatform('Macintosh')

    handleOscLink(
      'docs/README.md',
      { metaKey: true, ctrlKey: false },
      {
        ...deps,
        startupCwd: '/tmp/project'
      }
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: '/tmp/project/docs/README.md'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/project/docs/README.md',
        relativePath: 'project/docs/README.md'
      })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('opens tilde OSC file links against explicit terminal home when cwd is outside home', async () => {
    setPlatform('Macintosh')

    handleOscLink(
      '~/file.ts',
      { metaKey: true, ctrlKey: false },
      {
        ...deps,
        startupCwd: '/workspace/project',
        terminalHomePath: '/home/alice'
      }
    )

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: '/home/alice/file.ts'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/home/alice/file.ts'
      })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('stats remote-runtime file links through the active runtime environment', async () => {
    setPlatform('Macintosh')
    storeState.settings = { activeRuntimeEnvironmentId: 'env-1' }
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: { size: 1, isDirectory: false, mtime: 1 },
      _meta: { runtimeId: 'remote-runtime' }
    })

    openDetectedFilePath('/tmp/src/main.ts', null, null, deps)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.stat',
        params: { worktree: 'wt-1', relativePath: 'src/main.ts' },
        timeoutMs: 15_000
      })
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/src/main.ts',
        relativePath: 'src/main.ts'
      })
    )
  })

  it('stats remote-runtime file links through the owning PTY runtime environment', async () => {
    setPlatform('Macintosh')
    storeState.settings = { activeRuntimeEnvironmentId: 'env-2' }
    runtimeEnvironmentCallMock.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: { size: 1, isDirectory: false, mtime: 1 },
      _meta: { runtimeId: 'remote-runtime' }
    })

    openDetectedFilePath('/tmp/src/main.ts', null, null, {
      ...deps,
      runtimeEnvironmentId: 'env-1'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'files.stat',
        params: { worktree: 'wt-1', relativePath: 'src/main.ts' },
        timeoutMs: 15_000
      })
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/tmp/src/main.ts',
        relativePath: 'src/main.ts',
        runtimeEnvironmentId: 'env-1'
      })
    )
  })

  it('opens SSH file links through Orca without local authorization', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')

    openDetectedFilePath('/home/me/repo/src/main.ts', null, null, {
      worktreeId: 'wt-1',
      worktreePath: '/home/me/repo',
      openWithSystemDefault: true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(statMock).toHaveBeenCalledWith({
      filePath: '/home/me/repo/src/main.ts',
      connectionId: 'ssh-1'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/home/me/repo/src/main.ts',
        relativePath: 'src/main.ts'
      })
    )
  })

  it('does not open SSH html file links as client-local file browser tabs', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')

    openDetectedFilePath('/home/me/repo/report.html', null, null, {
      worktreeId: 'wt-1',
      worktreePath: '/home/me/repo',
      openWithSystemDefault: true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/home/me/repo/report.html',
        relativePath: 'report.html'
      })
    )
  })

  it('does not ask the client OS to open SSH directories', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    statMock.mockResolvedValueOnce({ isDirectory: true })

    openDetectedFilePath('/home/me/repo/src', null, null, {
      worktreeId: 'wt-1',
      worktreePath: '/home/me/repo'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
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
      expect.objectContaining({ filePath: '/tmp/src/second.ts' })
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(1, null)
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '/tmp/src/second.ts',
      line: 20,
      column: 3,
      matchLength: 0
    })
  })
})

describe('createFilePathLinkProvider range bounds', () => {
  type TestBufferLine = {
    isWrapped: boolean
    length: number
    translateToString: (
      trimRight?: boolean,
      startColumn?: number,
      endColumn?: number,
      outColumns?: number[]
    ) => string
  }

  function defaultColumnsForText(text: string): number[] {
    return Array.from({ length: text.length + 1 }, (_value, index) => index)
  }

  function makeBufferLine(
    text: string,
    options: { isWrapped?: boolean; columns?: number[] } = {}
  ): TestBufferLine {
    const columns = options.columns ?? defaultColumnsForText(text)
    return {
      isWrapped: options.isWrapped ?? false,
      length: text.length,
      translateToString: (
        _trimRight?: boolean,
        startColumn = 0,
        endColumn = text.length,
        outColumns?: number[]
      ) => {
        if (outColumns) {
          outColumns.length = 0
          for (let index = startColumn; index <= endColumn; index++) {
            outColumns.push(columns[index] ?? index)
          }
        }
        return text.slice(startColumn, endColumn)
      }
    }
  }

  function makePane(rows: TestBufferLine[]): { id: number; terminal: unknown } {
    return {
      id: 1,
      terminal: {
        buffer: {
          active: {
            getLine: (y: number) => rows[y]
          }
        }
      }
    }
  }

  function createProviderSetup(rows: TestBufferLine[]) {
    const pane = makePane(rows)
    const managerRef = {
      current: { getPanes: () => [pane] } as unknown as PaneManager
    }
    const linkTooltip = { textContent: '', style: { display: '' } } as unknown as HTMLElement
    const provider = createFilePathLinkProvider(
      1,
      {
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        startupCwd: '/repo',
        managerRef,
        linkProviderDisposablesRef: { current: new Map<number, IDisposable>() },
        pathExistsCache: new Map<string, boolean>([
          ['/repo/CLAUDE.md', true],
          ['/repo/package.json', true],
          ['/repo/Folder With Space/content.js', true],
          ['/repo/My Folder', true]
        ])
      },
      linkTooltip,
      getTerminalFileOpenHint()
    )
    return { provider, linkTooltip }
  }

  function createProvider(rows: TestBufferLine[]) {
    return createProviderSetup(rows).provider
  }

  function collectLinks(
    rowsOrText: TestBufferLine[] | string,
    bufferLineNumber = 1
  ): Promise<ILink[]> {
    const rows = typeof rowsOrText === 'string' ? [makeBufferLine(rowsOrText)] : rowsOrText
    const provider = createProvider(rows)
    return new Promise<ILink[]>((resolve) => {
      provider.provideLinks(bufferLineNumber, (links) => resolve(links ?? []))
    })
  }

  function containsBufferPoint(link: ILink, x: number, y: number): boolean {
    const { start, end } = link.range
    if (y < start.y || y > end.y) {
      return false
    }
    if (start.y === end.y) {
      return x >= start.x && x <= end.x
    }
    if (y === start.y) {
      return x >= start.x
    }
    if (y === end.y) {
      return x <= end.x
    }
    return true
  }

  function makeBuffer(
    rows: TestBufferLine[]
  ): Parameters<typeof openFilePathLinkAtBufferPosition>[0] {
    return { getLine: (y: number) => rows[y] } as Parameters<
      typeof openFilePathLinkAtBufferPosition
    >[0]
  }

  function makeFallbackTerminal(rows: TestBufferLine[]): {
    terminal: Parameters<typeof installFilePathLinkClickFallback>[1] &
      Parameters<typeof installHttpLinkClickFallback>[0]
    element: {
      addEventListener: ReturnType<typeof vi.fn>
      removeEventListener: ReturnType<typeof vi.fn>
      querySelector: ReturnType<typeof vi.fn>
    }
  } {
    const screen = {
      classList: { contains: vi.fn(() => true) },
      getBoundingClientRect: () => ({
        left: 10,
        top: 20,
        width: 800,
        height: 400
      })
    }
    const element = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      querySelector: vi.fn(() => screen)
    }
    return {
      terminal: {
        cols: 80,
        rows: 40,
        element,
        buffer: {
          active: {
            viewportY: 0,
            getLine: (y: number) => rows[y]
          }
        },
        clearSelection: vi.fn()
      } as unknown as Parameters<typeof installFilePathLinkClickFallback>[1],
      element
    }
  }

  function getRegisteredMouseUpHandler(element: {
    addEventListener: ReturnType<typeof vi.fn>
  }): (event: MouseEvent) => void {
    const registration = element.addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'mouseup'
    )
    expect(registration, 'mouseup handler should be registered').toBeDefined()
    expect(registration![2]).toEqual({ capture: true })
    return registration![1] as (event: MouseEvent) => void
  }

  function getRegisteredBubbleMouseUpHandler(element: {
    addEventListener: ReturnType<typeof vi.fn>
  }): (event: MouseEvent) => void {
    const registration = element.addEventListener.mock.calls.find(
      ([eventName, _handler, options]) => eventName === 'mouseup' && options === undefined
    )
    expect(registration, 'bubble mouseup handler should be registered').toBeDefined()
    return registration![1] as (event: MouseEvent) => void
  }

  it('underlines only the filename itself, not the column padding from `ls`', async () => {
    // ls pads each column with trailing spaces. Regression: the provider used
    // to report `end.x = endIndex + 1`, which in xterm's 1-based *inclusive*
    // convention overshoots the last filename cell by one, underlining the
    // trailing space as well ("package.json ").
    const line = 'CLAUDE.md      package.json     README.md'
    const links = await collectLinks(line)
    const byText = new Map(links.map((link) => [link.text, link]))

    const claude = byText.get('CLAUDE.md')
    expect(claude, 'CLAUDE.md should be linkified').toBeDefined()
    // 'CLAUDE.md' occupies cols 1..9 (inclusive, 1-based). end.x must be 9.
    expect(claude!.range.start.x).toBe(1)
    expect(claude!.range.end.x).toBe('CLAUDE.md'.length)

    const pkg = byText.get('package.json')
    expect(pkg, 'package.json should be linkified').toBeDefined()
    // 'package.json' starts at index 15 → col 16; inclusive end at col 15+12 = 27.
    const pkgStartIndex = line.indexOf('package.json')
    expect(pkg!.range.start.x).toBe(pkgStartIndex + 1)
    expect(pkg!.range.end.x).toBe(pkgStartIndex + 'package.json'.length)
  })

  it('shows the Orca plus default-app hint for local file link hover', async () => {
    setPlatform('Macintosh')
    const { provider, linkTooltip } = createProviderSetup([makeBufferLine('CLAUDE.md')])

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })
    expect(links[0]).toBeDefined()
    links[0]!.hover?.({} as MouseEvent, links[0]!.text)

    expect(linkTooltip.textContent).toBe(
      '/repo/CLAUDE.md (⌘+click to open or ⇧⌘+click for default app)'
    )
  })

  it('shows the Orca hint for SSH file link hover', async () => {
    setPlatform('Macintosh')
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')
    const { provider, linkTooltip } = createProviderSetup([makeBufferLine('CLAUDE.md')])

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })
    expect(links[0]).toBeDefined()
    links[0]!.hover?.({} as MouseEvent, links[0]!.text)

    expect(linkTooltip.textContent).toBe('/repo/CLAUDE.md (⌘+click to open in Orca)')
  })

  it('bounds the terminal path-exists cache while preserving recent probes', async () => {
    const pathExistsCache = new Map<string, boolean>()
    for (let index = 0; index < TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES; index += 1) {
      pathExistsCache.set(`active\0/repo/old-${index}.ts`, true)
    }
    const pane = makePane([makeBufferLine('fresh.ts')])
    const managerRef = {
      current: { getPanes: () => [pane] } as unknown as PaneManager
    }
    const provider = createFilePathLinkProvider(
      1,
      {
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        startupCwd: '/repo',
        managerRef,
        linkProviderDisposablesRef: { current: new Map<number, IDisposable>() },
        pathExistsCache
      },
      { textContent: '', style: { display: '' } } as unknown as HTMLElement,
      getTerminalFileOpenHint()
    )

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })

    expect(links.map((link) => link.text)).toEqual(['fresh.ts'])
    expect(pathExistsCache.size).toBe(TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES)
    expect(pathExistsCache.has('active\0/repo/old-0.ts')).toBe(false)
    expect(pathExistsCache.get('active\0/repo/fresh.ts')).toBe(true)
  })

  it('does not reuse SSH path-exists cache entries across connections', async () => {
    setPlatform('Macintosh')
    const pathExistsCache = new Map<string, boolean>()
    const rows = [makeBufferLine('shared.ts')]
    const pane = makePane(rows)
    const managerRef = {
      current: { getPanes: () => [pane] } as unknown as PaneManager
    }
    const deps = {
      worktreeId: 'wt-1',
      worktreePath: '/repo',
      startupCwd: '/repo',
      managerRef,
      linkProviderDisposablesRef: { current: new Map<number, IDisposable>() },
      pathExistsCache
    }

    vi.mocked(getConnectionId).mockReturnValue('ssh-one')
    const firstProvider = createFilePathLinkProvider(
      1,
      deps,
      { textContent: '', style: { display: '' } } as unknown as HTMLElement,
      getTerminalFileOpenHint()
    )
    const firstLinks = await new Promise<ILink[]>((resolve) => {
      firstProvider.provideLinks(1, (provided) => resolve(provided ?? []))
    })
    expect(firstLinks.map((link) => link.text)).toEqual(['shared.ts'])
    expect(statMock).toHaveBeenCalledWith({
      filePath: '/repo/shared.ts',
      connectionId: 'ssh-one'
    })

    vi.mocked(getConnectionId).mockReturnValue('ssh-two')
    statMock.mockRejectedValueOnce(new Error('ENOENT'))
    const secondProvider = createFilePathLinkProvider(
      1,
      deps,
      { textContent: '', style: { display: '' } } as unknown as HTMLElement,
      getTerminalFileOpenHint()
    )
    const secondLinks = await new Promise<ILink[]>((resolve) => {
      secondProvider.provideLinks(1, (provided) => resolve(provided ?? []))
    })

    expect(secondLinks).toEqual([])
    expect(statMock).toHaveBeenLastCalledWith({
      filePath: '/repo/shared.ts',
      connectionId: 'ssh-two'
    })
  })

  it('opens a single-row file path from a direct modifier-click fallback', async () => {
    setPlatform('Macintosh')
    const pathExists = createDeferred<boolean>()
    vi.mocked(window.api.shell.pathExists).mockImplementation(() => pathExists.promise)

    const opened = openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('package.json')]),
      { x: 4, y: 1 },
      80,
      {
        startupCwd: '/tmp',
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        runtimeEnvironmentId: null
      }
    )
    await flushAsyncWork()

    expect(opened).toBe(true)
    // Why: direct click fallback cannot wait for xterm's hover-time async
    // existence probe; openDetectedFilePath still stats before routing.
    expect(window.api.shell.pathExists).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/package.json' })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('opens a single-row file path with the system default from shift modifier fallback', async () => {
    setPlatform('Macintosh')

    const opened = openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('package.json')]),
      { x: 4, y: 1 },
      80,
      {
        startupCwd: '/tmp',
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        runtimeEnvironmentId: null,
        openWithSystemDefault: true
      }
    )
    await flushAsyncWork()

    expect(opened).toBe(true)
    expect(openFilePathMock).toHaveBeenCalledWith('/tmp/package.json')
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('opens a tilde-prefixed path from a direct modifier-click fallback', async () => {
    setPlatform('Macintosh')

    const opened = openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('~/Documents/Path/file_name')]),
      { x: 4, y: 1 },
      80,
      {
        startupCwd: '/Users/alice/project',
        worktreeId: 'wt-1',
        worktreePath: '/Users/alice/project',
        runtimeEnvironmentId: null
      }
    )
    await flushAsyncWork()

    expect(opened).toBe(true)
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/Users/alice/Documents/Path/file_name' })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('opens a tilde path using explicit terminal home when cwd is outside home', async () => {
    setPlatform('Macintosh')

    const opened = openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('~/Documents/Path/file_name')]),
      { x: 4, y: 1 },
      80,
      {
        startupCwd: '/workspace/project',
        terminalHomePath: '/home/alice',
        worktreeId: 'wt-1',
        worktreePath: '/workspace/project',
        runtimeEnvironmentId: null
      }
    )
    await flushAsyncWork()

    expect(opened).toBe(true)
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/home/alice/Documents/Path/file_name' })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('opens a wrapped continuation-row html path from a direct modifier-click fallback', async () => {
    setPlatform('Macintosh')
    const rows = [
      makeBufferLine('open mobile/mock-'),
      makeBufferLine('homepage.html', { isWrapped: true })
    ]

    const opened = openFilePathLinkAtBufferPosition(
      makeBuffer(rows),
      { x: 'home'.length, y: 2 },
      20,
      {
        startupCwd: '/tmp',
        worktreeId: 'wt-1',
        worktreePath: '/tmp',
        runtimeEnvironmentId: null
      }
    )
    await flushAsyncWork()

    expect(opened).toBe(true)
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'wt-1',
      'file:///tmp/mobile/mock-homepage.html',
      expect.objectContaining({ title: 'mock-homepage.html', activate: true })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('returns one file link for an absolute path containing spaces', async () => {
    const pathText = '/repo/Folder With Space/content.js'
    const links = await collectLinks(pathText)

    expect(links.map((link) => link.text)).toEqual([pathText])
    expect(links[0].range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: pathText.length, y: 1 }
    })
  })

  it('returns one file link for an extensionless path ending in a spaced segment', async () => {
    const pathText = '/repo/My Folder'
    const links = await collectLinks(pathText)

    expect(links.map((link) => link.text)).toEqual([pathText])
    expect(links[0].range).toEqual({
      start: { x: 1, y: 1 },
      end: { x: pathText.length, y: 1 }
    })
  })

  it('returns an existing extensionless spaced prefix before trailing prose', async () => {
    vi.mocked(window.api.shell.pathExists).mockImplementation(async (pathValue) => {
      return pathValue === '/repo/My Folder'
    })

    const links = await collectLinks('see /repo/My Folder now')

    expect(links.map((link) => link.text)).toEqual(['/repo/My Folder'])
  })

  it('opens an existing extensionless spaced prefix from direct fallback cache', async () => {
    setPlatform('Macintosh')
    const line = 'see /repo/My Folder now'

    const opened = openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine(line)]),
      { x: line.indexOf('Folder') + 1, y: 1 },
      80,
      {
        startupCwd: '/repo',
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        runtimeEnvironmentId: null,
        pathExistsCache: new Map<string, boolean>([
          ['active\0/repo/My Folder now', false],
          ['active\0/repo/My Folder', true]
        ])
      }
    )
    await flushAsyncWork()

    expect(opened).toBe(true)
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/My Folder' })
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('retries a wrapped file click even when xterm already marked the link active', async () => {
    setPlatform('Macintosh')
    const rows = [
      makeBufferLine('/private/tmp/orca-setup-e2e.hOW01f/workspaces/test-wt-5/mobile/'),
      makeBufferLine('packages/expo-two-way-audio/android/src/main/java/expo/modules/'),
      makeBufferLine('twowayaudio/ExpoTwoWayAudioLifeCycleListener.kt')
    ]
    const { terminal, element } = makeFallbackTerminal(rows)
    const disposable = installFilePathLinkClickFallback(1, terminal, {
      startupCwd: '/private/tmp/orca-setup-e2e.hOW01f/workspaces/test-wt-5',
      worktreeId: 'wt-1',
      worktreePath: '/private/tmp/orca-setup-e2e.hOW01f/workspaces/test-wt-5',
      runtimeEnvironmentId: null,
      managerRef: { current: null },
      linkProviderDisposablesRef: { current: new Map<number, IDisposable>() },
      pathExistsCache: new Map<string, boolean>()
    })
    const mouseUp = getRegisteredMouseUpHandler(element)
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    mouseUp({
      button: 0,
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
      clientX: 20,
      clientY: 45,
      preventDefault,
      stopPropagation
    } as unknown as MouseEvent)
    await flushAsyncWork()

    expect(openFilePathMock).toHaveBeenCalledWith(
      '/private/tmp/orca-setup-e2e.hOW01f/workspaces/test-wt-5/mobile/packages/expo-two-way-audio/android/src/main/java/expo/modules/twowayaudio/ExpoTwoWayAudioLifeCycleListener.kt'
    )
    expect(preventDefault).toHaveBeenCalled()
    expect(stopPropagation).toHaveBeenCalled()
    expect(terminal.clearSelection).toHaveBeenCalled()

    disposable.dispose()
    expect(element.removeEventListener).toHaveBeenCalledWith('mouseup', mouseUp, { capture: true })
  })

  it('does not intercept regular URL clicks in the file-path fallback', async () => {
    setPlatform('Macintosh')
    const rows = [
      makeBufferLine('PR opened: https://github.com/stablyai/orca-marketing-website/pull/82')
    ]
    const { terminal, element } = makeFallbackTerminal(rows)
    const disposable = installFilePathLinkClickFallback(1, terminal, {
      startupCwd: '/tmp',
      worktreeId: 'wt-1',
      worktreePath: '/tmp',
      runtimeEnvironmentId: null,
      managerRef: { current: null },
      linkProviderDisposablesRef: { current: new Map<number, IDisposable>() },
      pathExistsCache: new Map<string, boolean>()
    })
    const mouseUp = getRegisteredMouseUpHandler(element)
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    mouseUp({
      button: 0,
      metaKey: true,
      ctrlKey: false,
      clientX: 230,
      clientY: 25,
      preventDefault,
      stopPropagation
    } as unknown as MouseEvent)
    await flushAsyncWork()

    expect(openFileMock).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(terminal.clearSelection).not.toHaveBeenCalled()

    disposable.dispose()
  })

  it('opens regular URLs from a direct modifier-click fallback when xterm did not handle them', async () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: false }
    const rows = [
      makeBufferLine('PR opened: https://github.com/stablyai/orca-marketing-website/pull/82')
    ]
    const { terminal, element } = makeFallbackTerminal(rows)
    const disposable = installHttpLinkClickFallback(terminal, { worktreeId: 'wt-1' })
    const mouseUp = getRegisteredBubbleMouseUpHandler(element)
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    mouseUp({
      button: 0,
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      defaultPrevented: false,
      clientX: 230,
      clientY: 25,
      preventDefault,
      stopPropagation
    } as unknown as MouseEvent)

    expect(openUrlMock).toHaveBeenCalledWith(
      'https://github.com/stablyai/orca-marketing-website/pull/82'
    )
    expect(preventDefault).toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(terminal.clearSelection).toHaveBeenCalled()

    disposable.dispose()
    expect(element.removeEventListener).toHaveBeenCalledWith('mouseup', mouseUp)
  })

  it('does not double-open URLs when xterm already handled the mouseup', () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: false }
    const rows = [makeBufferLine('Open https://github.com/stablyai/orca/pull/2914')]
    const { terminal, element } = makeFallbackTerminal(rows)
    const disposable = installHttpLinkClickFallback(terminal, { worktreeId: 'wt-1' })
    const mouseUp = getRegisteredBubbleMouseUpHandler(element)

    mouseUp({
      button: 0,
      metaKey: true,
      ctrlKey: false,
      defaultPrevented: true,
      clientX: 90,
      clientY: 25,
      preventDefault: vi.fn()
    } as unknown as MouseEvent)

    expect(openUrlMock).not.toHaveBeenCalled()
    expect(terminal.clearSelection).not.toHaveBeenCalled()

    disposable.dispose()
  })

  it('opens a deeply wrapped absolute path from its final short continuation row', async () => {
    setPlatform('Macintosh')
    const rows = [
      makeBufferLine('/private/tmp/or'),
      makeBufferLine('ca-setup-e2e.hO'),
      makeBufferLine('W01f/workspaces'),
      makeBufferLine('/test-wt-5/mob'),
      makeBufferLine('ile/packages/ex'),
      makeBufferLine('po-two-way-aud'),
      makeBufferLine('io/android/src/'),
      makeBufferLine('main/java/expo'),
      makeBufferLine('/modules/twoway'),
      makeBufferLine('audio/ExpoTwoW'),
      makeBufferLine('ayAudioLifeCyc'),
      makeBufferLine('leListener.kt')
    ]

    const opened = openFilePathLinkAtBufferPosition(makeBuffer(rows), { x: 4, y: 12 }, 15, {
      startupCwd: '/private/tmp/orca-setup-e2e.hOW01f/workspaces/test-wt-5',
      worktreeId: 'wt-1',
      worktreePath: '/private/tmp/orca-setup-e2e.hOW01f/workspaces/test-wt-5',
      runtimeEnvironmentId: null,
      openWithSystemDefault: true
    })
    await flushAsyncWork()

    expect(opened).toBe(true)
    expect(openFilePathMock).toHaveBeenCalledWith(
      '/private/tmp/orca-setup-e2e.hOW01f/workspaces/test-wt-5/mobile/packages/expo-two-way-audio/android/src/main/java/expo/modules/twowayaudio/ExpoTwoWayAudioLifeCycleListener.kt'
    )
  })

  it('returns a wrapped file link when hovering the first physical row', async () => {
    const rows = [
      makeBufferLine('open src/components/'),
      makeBufferLine('terminal-link-handlers.ts', { isWrapped: true })
    ]

    const links = await collectLinks(rows, 1)
    const link = links.find(
      (candidate) => candidate.text === 'src/components/terminal-link-handlers.ts'
    )

    expect(link, 'wrapped path should be linkified from the first row').toBeDefined()
    expect(link!.range).toEqual({
      start: { x: 'open '.length + 1, y: 1 },
      end: { x: 'terminal-link-handlers.ts'.length, y: 2 }
    })
  })

  it('returns the same wrapped file link when hovering the continuation row', async () => {
    const rows = [
      makeBufferLine('open src/components/'),
      makeBufferLine('terminal-link-handlers.ts', { isWrapped: true })
    ]

    const firstRowLinks = await collectLinks(rows, 1)
    const continuationLinks = await collectLinks(rows, 2)
    const firstRowLink = firstRowLinks.find(
      (candidate) => candidate.text === 'src/components/terminal-link-handlers.ts'
    )
    const continuationLink = continuationLinks.find(
      (candidate) => candidate.text === 'src/components/terminal-link-handlers.ts'
    )

    expect(
      continuationLink,
      'wrapped path should be linkified from the continuation row'
    ).toBeDefined()
    expect(continuationLink!.text).toBe(firstRowLink!.text)
    expect(continuationLink!.range).toEqual(firstRowLink!.range)
  })

  it('maps file link columns through multi-code-unit characters before the path', async () => {
    const text = 'e\u0301 src/main.ts'
    const columns = [0, 0, 1]
    for (let index = 3; index < text.length; index++) {
      columns[index] = index - 1
    }
    columns[text.length] = text.length - 1

    const links = await collectLinks([makeBufferLine(text, { columns })])
    const link = links.find((candidate) => candidate.text === 'src/main.ts')

    expect(link, 'unicode-prefixed path should be linkified').toBeDefined()
    expect(link!.range.start.x).toBe(3)
    expect(link!.range.end.x).toBe(text.length - 1)
  })

  it('drops stale async file links when wrapped rows change before existence resolves', async () => {
    const rows = [
      makeBufferLine('open src/components/'),
      makeBufferLine('terminal-link-handlers.ts', { isWrapped: true })
    ]
    const provider = createProvider(rows)
    const exists = createDeferred<boolean>()
    vi.mocked(window.api.shell.pathExists).mockImplementation(() => exists.promise)
    const callback = vi.fn()

    provider.provideLinks(1, callback)
    rows[0] = makeBufferLine('changed src/other/')

    exists.resolve(true)
    await flushAsyncWork()
    await flushAsyncWork()

    expect(callback).not.toHaveBeenCalled()
  })

  it('reports multi-row ranges that hit-test at wrapped-link boundaries', async () => {
    const rows = [
      makeBufferLine('trace src/very/long/'),
      makeBufferLine('nested/file.ts done', { isWrapped: true })
    ]

    const links = await collectLinks(rows, 2)
    const link = links.find((candidate) => candidate.text === 'src/very/long/nested/file.ts')

    expect(link, 'multi-row path should be linkified').toBeDefined()
    expect(containsBufferPoint(link!, 'trace '.length, 1)).toBe(false)
    expect(containsBufferPoint(link!, 'trace '.length + 1, 1)).toBe(true)
    expect(containsBufferPoint(link!, 'nested/file.ts'.length, 2)).toBe(true)
    expect(containsBufferPoint(link!, 'nested/file.ts'.length + 1, 2)).toBe(false)
  })
})
