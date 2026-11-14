import type { IDisposable } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { installFilePathLinkClickFallback } from './files/terminal-link-handlers'
import { openFilePathLinkAtBufferPosition } from './files/terminal-file-link-hit-testing'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import {
  getRegisteredMouseUpHandler,
  makeBuffer,
  makeBufferLine,
  makeExistsCache,
  makeFallbackTerminal
} from './files/terminal-link-provider-buffer-fixtures'
import {
  flushAsyncWork,
  flushDoubleRaf,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState, openFileMock, openFilePathMock, createBrowserTabMock } = doubles

vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('../../../../../shared/editor-language/editor-language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/workspace/ownership/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

describe('createFilePathLinkProvider range bounds', () => {
  it('opens a wrapped continuation-row html path from a direct modifier-click fallback', async () => {
    setPlatform('Macintosh')
    storeState.settings = { openLinksInApp: true }
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
        pathExistsCache: makeExistsCache([
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

  it('retries a direct file click when a cached missing path expires', async () => {
    setPlatform('Macintosh')
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_999)
    const pathExistsCache = new Map([
      ['active\0/tmp/eventually-created.ts', { exists: false, checkedAt: 1_000, sequence: 0 }]
    ])
    const openAtCurrentTime = (): boolean =>
      openFilePathLinkAtBufferPosition(
        makeBuffer([makeBufferLine('eventually-created.ts')]),
        { x: 4, y: 1 },
        80,
        {
          startupCwd: '/tmp',
          worktreeId: 'wt-1',
          worktreePath: '/tmp',
          runtimeEnvironmentId: null,
          pathExistsCache
        }
      )

    expect(openAtCurrentTime()).toBe(false)
    expect(openFileMock).not.toHaveBeenCalled()

    now.mockReturnValue(11_000)
    expect(openAtCurrentTime()).toBe(true)
    await flushAsyncWork()

    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/tmp/eventually-created.ts' }),
      { forceContentReload: true }
    )
    now.mockRestore()
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
      pathExistsCache: makeExistsCache()
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
      '/private/tmp/orca-setup-e2e.hOW01f/workspaces/test-wt-5/mobile/packages/expo-two-way-audio/android/src/main/java/expo/modules/twowayaudio/ExpoTwoWayAudioLifeCycleListener.kt',
      'local'
    )
    expect(preventDefault).toHaveBeenCalled()
    expect(stopPropagation).toHaveBeenCalled()
    expect(terminal.clearSelection).toHaveBeenCalled()

    disposable.dispose()
    expect(element.removeEventListener).toHaveBeenCalledWith('mouseup', mouseUp, { capture: true })
  })

  const columns = 80
  const urlFillingFirstRow = `${'http://localhost:6017/?args='.padEnd(columns - '&path='.length, 'x')}&path=`
  const wrappedUrlTail = '/story/foo--bar'.padEnd(columns)

  it.each([
    {
      name: 'a path after the port',
      rows: [makeBufferLine('http://localhost:5173/settings/profile')],
      position: { x: 24, y: 1 }
    },
    {
      name: 'a soft-wrapped row',
      rows: [
        makeBufferLine(urlFillingFirstRow),
        makeBufferLine(wrappedUrlTail, { isWrapped: true })
      ],
      position: { x: 4, y: 2 }
    },
    {
      name: 'a hard-wrapped row',
      rows: [makeBufferLine(urlFillingFirstRow), makeBufferLine(wrappedUrlTail)],
      position: { x: 4, y: 2 }
    }
  ])('leaves a URL cell to the URL: $name', ({ rows, position }) => {
    setPlatform('Macintosh')

    const opened = openFilePathLinkAtBufferPosition(makeBuffer(rows), position, columns, {
      startupCwd: '/tmp',
      worktreeId: 'wt-1',
      worktreePath: '/tmp',
      runtimeEnvironmentId: null
    })

    expect(opened).toBe(false)
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
      '/private/tmp/orca-setup-e2e.hOW01f/workspaces/test-wt-5/mobile/packages/expo-two-way-audio/android/src/main/java/expo/modules/twowayaudio/ExpoTwoWayAudioLifeCycleListener.kt',
      'local'
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
    const pathExistsCache = makeExistsCache([[`active\0/repo/${middlePath}`, true]])
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
