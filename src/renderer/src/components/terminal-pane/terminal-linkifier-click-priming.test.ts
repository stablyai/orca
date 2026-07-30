import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTerminalLinkifierClickPriming } from './terminal-linkifier-click-priming'

type ListenerRegistration = [string, EventListener, AddEventListenerOptions | boolean | undefined]

type FakeLinkifier = {
  _activeLine?: number
  _currentLink?: unknown
  _handleMouseMove?: (event: MouseEvent) => void
  _lastBufferCell?: unknown
}

function createTerminal(linkifier: FakeLinkifier | null | undefined): {
  terminal: Terminal
  registrations: ListenerRegistration[]
  removeEventListener: ReturnType<typeof vi.fn>
} {
  const registrations: ListenerRegistration[] = []
  const removeEventListener = vi.fn()
  const element = {
    addEventListener: (
      name: string,
      listener: EventListener,
      options?: AddEventListenerOptions | boolean
    ) => registrations.push([name, listener, options]),
    removeEventListener
  }
  return {
    terminal: {
      _core: linkifier ? { linkifier } : undefined,
      element
    } as unknown as Terminal,
    registrations,
    removeEventListener
  }
}

function modifierMouseDown(options: {
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
}): MouseEvent {
  return {
    button: 0,
    ctrlKey: options.ctrlKey ?? false,
    metaKey: options.metaKey ?? false,
    shiftKey: options.shiftKey ?? false
  } as MouseEvent
}

function getMouseDownHandler(registrations: ListenerRegistration[]): EventListener {
  const handler = registrations.find(
    ([name, _listener, options]) =>
      name === 'mousedown' &&
      typeof options === 'object' &&
      options !== null &&
      options.capture === true
  )?.[1]
  expect(handler).toBeDefined()
  return handler!
}

describe('installTerminalLinkifierClickPriming', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('primes a fresh OSC link before xterm snapshots a macOS mousedown', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const order: string[] = []
    const linkifier: FakeLinkifier = {
      _activeLine: 14,
      _lastBufferCell: { x: 8, y: 14 },
      _handleMouseMove(event) {
        expect(event.metaKey).toBe(true)
        expect(this._activeLine).toBe(-1)
        expect(this._lastBufferCell).toBeUndefined()
        this._currentLink = { link: 'https://example.com/fresh' }
        order.push('prime')
      }
    }
    const { terminal, registrations } = createTerminal(linkifier)
    installTerminalLinkifierClickPriming(terminal)

    getMouseDownHandler(registrations)(modifierMouseDown({ metaKey: true }))
    order.push(linkifier._currentLink ? 'snapshot-link' : 'snapshot-empty')

    expect(order).toEqual(['prime', 'snapshot-link'])
  })

  it('uses Ctrl on non-Mac platforms and preserves Shift for routing', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    const handleMouseMove = vi.fn()
    const { terminal, registrations } = createTerminal({ _handleMouseMove: handleMouseMove })
    installTerminalLinkifierClickPriming(terminal)
    const mouseDown = getMouseDownHandler(registrations)

    mouseDown(modifierMouseDown({ ctrlKey: true, shiftKey: true }))
    mouseDown(modifierMouseDown({ metaKey: true }))

    expect(handleMouseMove).toHaveBeenCalledOnce()
    expect(handleMouseMove.mock.calls[0][0].shiftKey).toBe(true)
  })

  it('does not clear established hover state before refreshing the click position', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const currentLink = { link: 'https://example.com/hovered' }
    const lastBufferCell = { x: 3, y: 5 }
    const linkifier: FakeLinkifier = {
      _activeLine: 5,
      _currentLink: currentLink,
      _lastBufferCell: lastBufferCell,
      _handleMouseMove: vi.fn()
    }
    const { terminal, registrations } = createTerminal(linkifier)
    installTerminalLinkifierClickPriming(terminal)

    getMouseDownHandler(registrations)(modifierMouseDown({ metaKey: true }))

    expect(linkifier._handleMouseMove).toHaveBeenCalledOnce()
    expect(linkifier._currentLink).toBe(currentLink)
    expect(linkifier._lastBufferCell).toBe(lastBufferCell)
    expect(linkifier._activeLine).toBe(5)
  })

  it('ignores plain clicks and degrades safely when xterm internals are unavailable', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const handleMouseMove = vi.fn()
    const present = createTerminal({ _handleMouseMove: handleMouseMove })
    const absent = createTerminal(null)
    installTerminalLinkifierClickPriming(present.terminal)
    installTerminalLinkifierClickPriming(absent.terminal)

    getMouseDownHandler(present.registrations)(modifierMouseDown({}))
    expect(() =>
      getMouseDownHandler(absent.registrations)(modifierMouseDown({ metaKey: true }))
    ).not.toThrow()
    expect(handleMouseMove).not.toHaveBeenCalled()
  })

  it('removes its capture listener on dispose', () => {
    const { terminal, registrations, removeEventListener } = createTerminal({})
    const disposable = installTerminalLinkifierClickPriming(terminal)
    const mouseDown = getMouseDownHandler(registrations)

    disposable.dispose()

    expect(removeEventListener).toHaveBeenCalledWith(
      'mousedown',
      mouseDown,
      expect.objectContaining({ capture: true })
    )
  })
})
