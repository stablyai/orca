import type { IBufferLine, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import { handleOscLink } from './terminal-osc-link-routing'
import { handleTerminalWebLinkClick } from './terminal-web-link-click'
import { installHttpLinkClickFallback } from './terminal-url-link-hit-testing'

const URL = 'http://example.com/'
const COLS = 80
const ROWS = 24

const openUrlMock = vi.fn()
const setActiveWorktreeMock = vi.fn()
const createBrowserTabMock = vi.fn()
const runtimeSourceOwner = { kind: 'runtime', runtimeEnvironmentId: 'env-1' } as const
const sshSourceOwner = { kind: 'ssh', connectionId: 'ssh-1' } as const

type ListenerRegistration = [string, EventListener, AddEventListenerOptions | boolean | undefined]

function makeBufferLine(text: string): IBufferLine {
  const padded = text.padEnd(COLS)
  return {
    isWrapped: false,
    length: COLS,
    translateToString: (
      _trimRight?: boolean,
      startColumn = 0,
      endColumn = padded.length,
      outColumns?: number[]
    ) => {
      if (outColumns) {
        outColumns.splice(
          0,
          outColumns.length,
          ...Array.from(
            { length: endColumn - startColumn + 1 },
            (_value, index) => index + startColumn
          )
        )
      }
      return padded.slice(startColumn, endColumn)
    }
  } as IBufferLine
}

function makeTerminal(): { terminal: Terminal; registrations: ListenerRegistration[] } {
  const registrations: ListenerRegistration[] = []
  const screen = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: COLS * 10, height: ROWS * 10 })
  }
  return {
    terminal: {
      cols: COLS,
      rows: ROWS,
      options: { mouseEventsRequireAlt: false },
      element: {
        ownerDocument: {
          defaultView: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
          addEventListener: vi.fn(),
          removeEventListener: vi.fn()
        },
        querySelector: vi.fn(() => screen),
        addEventListener: vi.fn(
          (name: string, listener: EventListener, options?: AddEventListenerOptions | boolean) => {
            registrations.push([name, listener, options])
          }
        ),
        removeEventListener: vi.fn()
      },
      buffer: {
        active: {
          viewportY: 0,
          getLine: (y: number) => (y === 0 ? makeBufferLine(URL) : undefined)
        }
      },
      clearSelection: vi.fn()
    } as unknown as Terminal,
    registrations
  }
}

function clickEvent(): MouseEvent {
  return {
    button: 0,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    clientX: 15,
    clientY: 5,
    preventDefault: vi.fn()
  } as unknown as MouseEvent
}

// Why: runtimes bind per workspace, so the global activeRuntimeEnvironmentId is
// null even while the clicked pane lives on a remote host.
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  vi.stubGlobal('window', { api: { shell: { openUrl: openUrlMock } } })
  registerHttpLinkStoreAccessor(() => ({
    settings: { openLinksInApp: true, activeRuntimeEnvironmentId: null },
    setActiveWorktree: setActiveWorktreeMock,
    createBrowserTab: createBrowserTabMock
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('terminal HTTP links on a runtime-hosted pane', () => {
  const baseDeps = { worktreeId: 'wt-1', worktreePath: '/tmp', startupCwd: '/tmp' }

  it('sends an OSC 8 hyperlink to the system browser', () => {
    expect(handleOscLink(URL, clickEvent(), { ...baseDeps, sourceOwner: runtimeSourceOwner })).toBe(
      true
    )

    expect(openUrlMock).toHaveBeenCalledWith(URL)
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
  })

  it('sends a WebLinksAddon click to the system browser', () => {
    const { terminal } = makeTerminal()

    expect(
      handleTerminalWebLinkClick(URL, clickEvent(), {
        ...baseDeps,
        terminal,
        sourceOwner: runtimeSourceOwner
      })
    ).toBe(true)

    expect(openUrlMock).toHaveBeenCalledWith(URL)
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('sends a click-fallback activation to the system browser', () => {
    const { terminal, registrations } = makeTerminal()
    const disposable = installHttpLinkClickFallback(terminal, {
      worktreeId: 'wt-1',
      getSourceOwner: () => runtimeSourceOwner
    })

    registrations.find(
      ([name, _listener, options]) => name === 'mouseup' && options === undefined
    )?.[1](clickEvent())

    expect(openUrlMock).toHaveBeenCalledWith(URL)
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('never prompts for the in-app routing preference it could not honor', () => {
    const requestOpenLinksInAppPreference = vi.fn(() => Promise.resolve(true))

    handleOscLink(URL, clickEvent(), {
      ...baseDeps,
      sourceOwner: runtimeSourceOwner,
      requestOpenLinksInAppPreference
    })

    expect(requestOpenLinksInAppPreference).not.toHaveBeenCalled()
    expect(openUrlMock).toHaveBeenCalledWith(URL)
  })
})

describe('terminal HTTP links on a direct SSH pane', () => {
  const baseDeps = { worktreeId: 'wt-1', worktreePath: '/tmp', startupCwd: '/tmp' }

  it('sends an OSC 8 hyperlink to the system browser', () => {
    expect(handleOscLink(URL, clickEvent(), { ...baseDeps, sourceOwner: sshSourceOwner })).toBe(
      true
    )

    expect(openUrlMock).toHaveBeenCalledWith(URL)
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
  })

  it('sends a WebLinksAddon click to the system browser', () => {
    const { terminal } = makeTerminal()

    expect(
      handleTerminalWebLinkClick(URL, clickEvent(), {
        ...baseDeps,
        terminal,
        sourceOwner: sshSourceOwner
      })
    ).toBe(true)

    expect(openUrlMock).toHaveBeenCalledWith(URL)
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('sends a click-fallback activation to the system browser', () => {
    const { terminal, registrations } = makeTerminal()
    const disposable = installHttpLinkClickFallback(terminal, {
      worktreeId: 'wt-1',
      getSourceOwner: () => sshSourceOwner
    })

    registrations.find(
      ([name, _listener, options]) => name === 'mouseup' && options === undefined
    )?.[1](clickEvent())

    expect(openUrlMock).toHaveBeenCalledWith(URL)
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    disposable.dispose()
  })
})

describe('terminal HTTP links on a local pane', () => {
  const baseDeps = { worktreeId: 'wt-1', worktreePath: '/tmp', startupCwd: '/tmp' }

  it('still opens an OSC 8 hyperlink in an Orca browser tab', () => {
    expect(handleOscLink(URL, clickEvent(), { ...baseDeps, runtimeEnvironmentId: null })).toBe(true)

    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', URL, { activate: true })
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it('still opens a click-fallback activation in an Orca browser tab', () => {
    const { terminal, registrations } = makeTerminal()
    const disposable = installHttpLinkClickFallback(terminal, { worktreeId: 'wt-1' })

    registrations.find(
      ([name, _listener, options]) => name === 'mouseup' && options === undefined
    )?.[1](clickEvent())

    expect(createBrowserTabMock).toHaveBeenCalledWith('wt-1', URL, { activate: true })
    expect(openUrlMock).not.toHaveBeenCalled()
    disposable.dispose()
  })
})
