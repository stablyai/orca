import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTerminalLinkPtyMouseSuppression } from './terminal-link-pty-mouse-suppression'

describe('terminal link PTY mouse suppression', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('temporarily gates PTY mouse reporting for a Cmd-click gesture', async () => {
    const registrations: [string, EventListener, AddEventListenerOptions | boolean | undefined][] =
      []
    const ownerWindow = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const ownerDocument = {
      defaultView: ownerWindow,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }
    const element = {
      ownerDocument,
      addEventListener: vi.fn(
        (name: string, listener: EventListener, options?: AddEventListenerOptions | boolean) => {
          registrations.push([name, listener, options])
        }
      ),
      removeEventListener: vi.fn()
    }
    const terminal = {
      element,
      options: { mouseEventsRequireAlt: false }
    } as unknown as Terminal
    const disposable = installTerminalLinkPtyMouseSuppression(terminal)
    const mouseDown = registrations.find(([name]) => name === 'mousedown')?.[1]
    const mouseUp = registrations.find(([name]) => name === 'mouseup')?.[1]

    mouseDown!({ button: 0, metaKey: true, ctrlKey: false } as unknown as MouseEvent)
    expect(terminal.options.mouseEventsRequireAlt).toBe(true)

    mouseUp!({} as MouseEvent)
    await Promise.resolve()
    expect(terminal.options.mouseEventsRequireAlt).toBe(false)

    disposable.dispose()
  })

  it('leaves ordinary clicks available to mouse-aware TUIs', () => {
    const registrations: [string, EventListener][] = []
    const element = {
      ownerDocument: null,
      addEventListener: vi.fn((name: string, listener: EventListener) => {
        registrations.push([name, listener])
      }),
      removeEventListener: vi.fn()
    }
    const terminal = {
      element,
      options: { mouseEventsRequireAlt: false }
    } as unknown as Terminal
    const disposable = installTerminalLinkPtyMouseSuppression(terminal)
    const mouseDown = registrations.find(([name]) => name === 'mousedown')?.[1]

    mouseDown!({ button: 0, metaKey: false, ctrlKey: false } as unknown as MouseEvent)

    expect(terminal.options.mouseEventsRequireAlt).toBe(false)
    disposable.dispose()
  })
})
