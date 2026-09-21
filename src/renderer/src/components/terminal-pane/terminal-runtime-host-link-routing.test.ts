import type { IBufferLine, Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from '@/lib/http-link-routing'
import { handleOscLink } from './terminal-osc-link-routing'
import { handleTerminalWebLinkClick } from './terminal-web-link-click'
import { installHttpLinkClickFallback } from './terminal-url-link-hit-testing'

const URL = 'http://example.com/'
const COLS = 80
const ROWS = 24

const openUrlMock = vi.fn()
const setActiveWorktreeMock = vi.fn()
const createBrowserTabMock = vi.fn()
const openRuntimeBrowserTabMock = vi.fn(() => Promise.resolve())
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
  registerWorkspaceHttpLinkBrowserOpener(openRuntimeBrowserTabMock)
})

afterEach(() => {
  registerWorkspaceHttpLinkBrowserOpener(null)
  vi.unstubAllGlobals()
})

describe('terminal HTTP links on a runtime-hosted pane', () => {
  const baseDeps = { worktreeId: 'wt-1', worktreePath: '/tmp', startupCwd: '/tmp' }

  it('opens an OSC 8 hyperlink on the owning runtime', () => {
    expect(handleOscLink(URL, clickEvent(), { ...baseDeps, sourceOwner: runtimeSourceOwner })).toBe(
      true
    )

    expect(openRuntimeBrowserTabMock).toHaveBeenCalledWith({
      workspaceId: 'wt-1',
      url: URL,
      intent: { kind: 'url' },
      expectedRuntimeEnvironmentId: 'env-1'
    })
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
  })

  it('opens a WebLinksAddon click on the owning runtime', () => {
    const { terminal } = makeTerminal()

    expect(
      handleTerminalWebLinkClick(URL, clickEvent(), {
        ...baseDeps,
        terminal,
        sourceOwner: runtimeSourceOwner
      })
    ).toBe(true)

    expect(openRuntimeBrowserTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRuntimeEnvironmentId: 'env-1', url: URL })
    )
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('opens a click-fallback activation on the owning runtime', () => {
    const { terminal, registrations } = makeTerminal()
    const disposable = installHttpLinkClickFallback(terminal, {
      worktreeId: 'wt-1',
      getSourceOwner: () => runtimeSourceOwner
    })

    registrations.find(
      ([name, _listener, options]) => name === 'mouseup' && options === undefined
    )?.[1](clickEvent())

    expect(openRuntimeBrowserTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRuntimeEnvironmentId: 'env-1', url: URL })
    )
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    disposable.dispose()
  })

  it('uses the persisted routing preference without prompting again', () => {
    const requestOpenLinksInAppPreference = vi.fn(() => Promise.resolve(true))

    handleOscLink(URL, clickEvent(), {
      ...baseDeps,
      sourceOwner: runtimeSourceOwner,
      requestOpenLinksInAppPreference
    })

    expect(requestOpenLinksInAppPreference).not.toHaveBeenCalled()
    expect(openRuntimeBrowserTabMock).toHaveBeenCalledOnce()
    expect(openUrlMock).not.toHaveBeenCalled()
  })
})

describe('terminal HTTP links on a direct SSH pane', () => {
  const baseDeps = { worktreeId: 'wt-1', worktreePath: '/tmp', startupCwd: '/tmp' }

  it('opens an OSC 8 hyperlink through the owning SSH workspace', () => {
    expect(handleOscLink(URL, clickEvent(), { ...baseDeps, sourceOwner: sshSourceOwner })).toBe(
      true
    )

    expect(openRuntimeBrowserTabMock).toHaveBeenCalledWith({
      workspaceId: 'wt-1',
      url: URL,
      intent: { kind: 'url' },
      expectedSshConnectionId: 'ssh-1'
    })
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
    expect(setActiveWorktreeMock).not.toHaveBeenCalled()
  })

  it('opens a WebLinksAddon click through the owning SSH workspace', () => {
    const { terminal } = makeTerminal()

    expect(
      handleTerminalWebLinkClick(URL, clickEvent(), {
        ...baseDeps,
        terminal,
        sourceOwner: sshSourceOwner
      })
    ).toBe(true)

    expect(openRuntimeBrowserTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSshConnectionId: 'ssh-1', url: URL })
    )
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('opens a click-fallback activation through the owning SSH workspace', () => {
    const { terminal, registrations } = makeTerminal()
    const disposable = installHttpLinkClickFallback(terminal, {
      worktreeId: 'wt-1',
      getSourceOwner: () => sshSourceOwner
    })

    registrations.find(
      ([name, _listener, options]) => name === 'mouseup' && options === undefined
    )?.[1](clickEvent())

    expect(openRuntimeBrowserTabMock).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSshConnectionId: 'ssh-1', url: URL })
    )
    expect(openUrlMock).not.toHaveBeenCalled()
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
