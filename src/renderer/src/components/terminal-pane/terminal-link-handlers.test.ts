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

const openUrlMock = vi.fn()
const openFileUriMock = vi.fn()
const openFileMock = vi.fn()
const authorizeExternalPathMock = vi.fn()
const statMock = vi.fn().mockResolvedValue({ isDirectory: false })
const setActiveWorktreeMock = vi.fn()
const createBrowserTabMock = vi.fn()

const deps = { worktreeId: 'wt-1', worktreePath: '/tmp' }
const storeState = {
  settings: undefined as { openLinksInApp?: boolean } | undefined,
  setActiveWorktree: setActiveWorktreeMock,
  createBrowserTab: createBrowserTabMock,
  openFile: openFileMock
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

function setPlatform(userAgent: string): void {
  vi.stubGlobal('navigator', { userAgent })
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.settings = undefined
  registerHttpLinkStoreAccessor(() => storeState)
  vi.stubGlobal('window', {
    api: {
      shell: {
        openUrl: openUrlMock,
        openFileUri: openFileUriMock,
        pathExists: vi.fn().mockResolvedValue(true)
      },
      fs: {
        authorizeExternalPath: authorizeExternalPathMock,
        stat: statMock
      }
    }
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
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'wt-1',
      'file:///tmp/legacy.HTM',
      expect.objectContaining({ title: 'legacy.HTM' })
    )
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
