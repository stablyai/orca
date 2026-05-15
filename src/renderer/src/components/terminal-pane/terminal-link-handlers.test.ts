/* eslint-disable max-lines -- Why: terminal link routing has intertwined local,
SSH, and runtime cases; keeping them in one suite prevents fixture drift. */
import type { IDisposable, ILink } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  createFilePathLinkProvider,
  getTerminalHtmlFileOpenHint,
  handleOscLink,
  isTerminalLinkActivation,
  openDetectedFilePath
} from './terminal-link-handlers'
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

  it('routes .html file paths straight into the embedded browser', async () => {
    setPlatform('Macintosh')

    openDetectedFilePath('/tmp/report.html', null, null, deps)

    // openDetectedFilePath is async (fire-and-forget), so flush the microtask queue
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Why: .html should not open Monaco — it should render in the browser tab.
    expect(openFileMock).not.toHaveBeenCalled()
    expect(setPendingEditorRevealMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'wt-1',
      'file:///tmp/report.html',
      expect.objectContaining({ title: 'report.html', activate: true })
    )
  })

  it('also routes .htm paths to the embedded browser', async () => {
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
  })

  it('schedules Monaco reveal with default column 1 for :line links', async () => {
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
  })

  it('preserves explicit column for :line:column links', async () => {
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
  })

  it('advertises the browser-open behavior in the html hover hint', () => {
    setPlatform('Macintosh')
    expect(getTerminalHtmlFileOpenHint()).toBe('⌘+click to open in browser')

    setPlatform('Windows')
    expect(getTerminalHtmlFileOpenHint()).toBe('Ctrl+click to open in browser')
  })

  it('opens file links in Orca instead of via shell when the platform modifier is pressed', async () => {
    setPlatform('Windows')

    handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: false }, deps)
    // Without modifier, nothing happens
    expect(openFileUriMock).not.toHaveBeenCalled()

    handleOscLink('file:///tmp/test.txt', { metaKey: false, ctrlKey: true }, deps)
    // Should NOT call shell.openFileUri (which opens system default editor)
    expect(openFileUriMock).not.toHaveBeenCalled()

    // openDetectedFilePath is async (fire-and-forget), so flush the microtask queue
    // before asserting on positive behavior.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: '/tmp/test.txt' })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/test.txt' })
    )
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
      worktreePath: '/home/me/repo'
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
      worktreePath: '/home/me/repo'
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

  it('ignores stale async completion so latest click wins for open and reveal', async () => {
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
    expect(setPendingEditorRevealMock).toHaveBeenCalledTimes(2)
  })
})

describe('createFilePathLinkProvider range bounds', () => {
  function makePane(lineText: string): { id: number; terminal: unknown } {
    return {
      id: 1,
      terminal: {
        buffer: {
          active: {
            getLine: (_y: number) => ({
              translateToString: (_trim: boolean) => lineText
            })
          }
        }
      }
    }
  }

  function collectLinks(lineText: string): Promise<ILink[]> {
    const pane = makePane(lineText)
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
        pathExistsCache: new Map<string, boolean>([
          ['/repo/CLAUDE.md', true],
          ['/repo/package.json', true]
        ])
      },
      { textContent: '', style: { display: '' } } as unknown as HTMLElement,
      'hint'
    )
    return new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (links) => resolve(links ?? []))
    })
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
})
