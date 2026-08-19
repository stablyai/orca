import type { IDisposable } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import {
  installFilePathLinkClickFallback,
  openFilePathLinkAtBufferPosition
} from './terminal-link-handlers'
import { installHttpLinkClickFallback } from './terminal-url-link-hit-testing'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  getRegisteredBubbleMouseUpHandler,
  getRegisteredMouseUpHandler,
  makeBuffer,
  makeBufferLine,
  makeFallbackTerminal
} from './terminal-link-provider-buffer-fixtures'
import {
  createDeferred,
  flushAsyncWork,
  flushDoubleRaf,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const {
  storeState,
  openUrlMock,
  openFileMock,
  openFilePathMock,
  createBrowserTabMock,
  setPendingEditorRevealMock,
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
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

describe('createFilePathLinkProvider range bounds', () => {
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
      expect.objectContaining({ filePath: '/tmp/package.json' }),
      { forceContentReload: true }
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('maps POSIX file paths for a WSL direct-click fallback before opening them', async () => {
    setPlatform('Windows')

    const opened = openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('/root/workspace/myrepo/README.md:5:3')]),
      { x: 10, y: 1 },
      80,
      {
        startupCwd: '/root/workspace/myrepo',
        worktreeId: 'wt-1',
        worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\repo',
        runtimeEnvironmentId: null,
        wslDistro: 'Ubuntu',
        pathExistsCache: new Map([
          ['active\0\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md', true]
        ])
      }
    )
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(opened).toBe(true)
    expect(statMock).toHaveBeenCalledWith({
      filePath: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md'
      }),
      { forceContentReload: true }
    )
    expect(setPendingEditorRevealMock).toHaveBeenNthCalledWith(2, {
      filePath: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md',
      fileId: '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md',
      line: 5,
      column: 3,
      matchLength: 0
    })
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
      expect.objectContaining({ filePath: '/Users/alice/Documents/Path/file_name' }),
      { forceContentReload: true }
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
      expect.objectContaining({ filePath: '/home/alice/Documents/Path/file_name' }),
      { forceContentReload: true }
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
      expect.objectContaining({ filePath: '/repo/My Folder' }),
      { forceContentReload: true }
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('does not open an unknown trailing-slash directory from direct fallback', async () => {
    setPlatform('Macintosh')

    const opened = openFilePathLinkAtBufferPosition(
      makeBuffer([makeBufferLine('/repo/unknown-dir/')]),
      { x: 8, y: 1 },
      80,
      {
        startupCwd: '/repo',
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        runtimeEnvironmentId: null,
        pathExistsCache: new Map([['active\0/repo/unknown-dir', true]])
      }
    )
    await flushAsyncWork()

    expect(opened).toBe(false)
    expect(openFilePathMock).not.toHaveBeenCalled()
    expect(openFileMock).not.toHaveBeenCalled()
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

  it('ignores regular URLs from a direct ordinary-click fallback on desktop', async () => {
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
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      defaultPrevented: false,
      clientX: 230,
      clientY: 25,
      preventDefault,
      stopPropagation
    } as unknown as MouseEvent)

    expect(openUrlMock).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(terminal.clearSelection).not.toHaveBeenCalled()

    disposable.dispose()
    expect(element.removeEventListener).toHaveBeenCalledWith('mouseup', mouseUp)
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

  it('does not steal macOS ctrl-click context-menu gestures in the URL fallback', async () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: false }
    const rows = [makeBufferLine('Open https://github.com/stablyai/orca/pull/2914')]
    const { terminal, element } = makeFallbackTerminal(rows)
    const disposable = installHttpLinkClickFallback(terminal, { worktreeId: 'wt-1' })
    const mouseUp = getRegisteredBubbleMouseUpHandler(element)
    const preventDefault = vi.fn()

    mouseUp({
      button: 0,
      metaKey: false,
      ctrlKey: true,
      shiftKey: false,
      defaultPrevented: false,
      clientX: 90,
      clientY: 25,
      preventDefault,
      stopPropagation: vi.fn()
    } as unknown as MouseEvent)

    expect(openUrlMock).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(terminal.clearSelection).not.toHaveBeenCalled()

    disposable.dispose()
  })

  it('asks for the first-use preference from the direct URL click fallback', async () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: false, openLinksInAppPreferencePrompted: false }
    const rows = [
      makeBufferLine('PR opened: https://github.com/stablyai/orca-marketing-website/pull/82')
    ]
    const requestOpenLinksInAppPreference = vi.fn(async () => {
      storeState.settings = { openLinksInApp: true, openLinksInAppPreferencePrompted: true }
      return true
    })
    const { terminal, element } = makeFallbackTerminal(rows)
    const disposable = installHttpLinkClickFallback(terminal, {
      worktreeId: 'wt-1',
      requestOpenLinksInAppPreference
    })
    const mouseUp = getRegisteredBubbleMouseUpHandler(element)
    const preventDefault = vi.fn()

    mouseUp({
      button: 0,
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      defaultPrevented: false,
      clientX: 230,
      clientY: 25,
      preventDefault,
      stopPropagation: vi.fn()
    } as unknown as MouseEvent)

    expect(requestOpenLinksInAppPreference).toHaveBeenCalledWith(
      'https://github.com/stablyai/orca-marketing-website/pull/82'
    )
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()

    await flushAsyncWork()

    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'wt-1',
      'https://github.com/stablyai/orca-marketing-website/pull/82',
      { activate: true }
    )
    expect(preventDefault).toHaveBeenCalled()
    expect(terminal.clearSelection).toHaveBeenCalled()

    disposable.dispose()
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

  it('opens the same boundary path from direct clicks on both physical halves', async () => {
    setPlatform('Macintosh')
    const firstPath = 'validation-screenshots/01-before-white-terminal-scrollbar-gutter.png'
    const middleStart = 'validation-screenshots/02-after-'
    const middleEnd = 'transparent-terminal-scrollbar-gutter.png'
    const middlePath = middleStart + middleEnd
    const thirdPath = 'validation-screenshots/03-after-light-theme.png'
    const rows = [
      makeBufferLine(`${firstPath} · ${middleStart}`),
      makeBufferLine(`${middleEnd} · ${thirdPath}`)
    ]
    const pathExistsCache = new Map([[`active\0/repo/${middlePath}`, true]])
    const positions = [
      { x: firstPath.length + ' · '.length + 2, y: 1 },
      { x: 2, y: 2 }
    ]

    for (const position of positions) {
      const opened = openFilePathLinkAtBufferPosition(makeBuffer(rows), position, 133, {
        startupCwd: '/repo',
        worktreeId: 'wt-1',
        worktreePath: '/repo',
        runtimeEnvironmentId: null,
        pathExistsCache
      })
      await flushDoubleRaf()

      expect(opened).toBe(true)
      expect(openFileMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ filePath: `/repo/${middlePath}` }),
        { forceContentReload: true }
      )
    }
    expect(openFileMock).toHaveBeenCalledTimes(2)
  })
})
