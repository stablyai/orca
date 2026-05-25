import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createForcedSelectionMouseEvent,
  installCopyOnSelectMouseSelectionForcing,
  isXtermScreenMouseTarget,
  shouldForceCopyOnSelectMouseSelection
} from './terminal-mouse-selection-forcing'

function mouseEvent(overrides: Partial<MouseEvent> = {}): MouseEvent {
  return {
    altKey: false,
    button: 0,
    buttons: 1,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    shiftKey: false,
    type: 'mousedown',
    ...overrides
  } as MouseEvent
}

type FakeMouseListener = (event: FakeMouseEvent) => void

class FakeMouseEvent {
  readonly altKey: boolean
  readonly bubbles: boolean
  readonly button: number
  readonly buttons: number
  readonly clientX: number
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly type: string
  defaultPrevented = false
  target: FakeElement | null = null
  stopped = false

  constructor(type: string, init: MouseEventInit = {}) {
    this.type = type
    this.altKey = init.altKey ?? false
    this.bubbles = init.bubbles ?? false
    this.button = init.button ?? 0
    this.buttons = init.buttons ?? 0
    this.clientX = init.clientX ?? 0
    this.ctrlKey = init.ctrlKey ?? false
    this.metaKey = init.metaKey ?? false
    this.shiftKey = init.shiftKey ?? false
  }

  preventDefault(): void {
    this.defaultPrevented = true
  }

  stopImmediatePropagation(): void {
    this.stopped = true
  }
}

class FakeElement {
  private listeners = new Map<string, { capture: boolean; listener: FakeMouseListener }[]>()
  className = ''
  parentElement: FakeElement | null = null

  appendChild(child: FakeElement): void {
    child.parentElement = this
  }

  addEventListener(
    type: string,
    listener: FakeMouseListener,
    options?: AddEventListenerOptions | boolean
  ): void {
    const listeners = this.listeners.get(type) ?? []
    const capture = typeof options === 'boolean' ? options : options?.capture === true
    listeners.push({ capture, listener })
    this.listeners.set(type, listeners)
  }

  removeEventListener(
    type: string,
    listener: FakeMouseListener,
    options?: EventListenerOptions | boolean
  ): void {
    const capture = typeof options === 'boolean' ? options : options?.capture === true
    const listeners = this.listeners.get(type) ?? []
    this.listeners.set(
      type,
      listeners.filter((entry) => entry.listener !== listener || entry.capture !== capture)
    )
  }

  dispatchEvent(event: FakeMouseEvent): boolean {
    event.target ??= this
    const path = this.eventPath()
    for (const node of path) {
      node.emit(event, true)
      if (event.stopped) {
        return !event.defaultPrevented
      }
    }
    const bubblePath = event.bubbles ? [...path].reverse() : [this]
    for (const node of bubblePath) {
      node.emit(event, false)
      if (event.stopped) {
        return !event.defaultPrevented
      }
    }
    return !event.defaultPrevented
  }

  closest(selector: string): FakeElement | null {
    if (selector !== '.xterm-screen') {
      return null
    }
    if (this.className.split(/\s+/).includes('xterm-screen')) {
      return this
    }
    return this.parentElement?.closest(selector) ?? null
  }

  private eventPath(): FakeElement[] {
    return this.parentElement ? [...this.parentElement.eventPath(), this] : [this]
  }

  private emit(event: FakeMouseEvent, capture: boolean): void {
    for (const { listener } of this.listeners
      .get(event.type)
      ?.filter((entry) => entry.capture === capture) ?? []) {
      listener(event)
      if (event.stopped) {
        return
      }
    }
  }
}

function installDomGlobals(): void {
  vi.stubGlobal('Element', FakeElement)
  vi.stubGlobal('MouseEvent', FakeMouseEvent)
}

function fakeElement(className = ''): FakeElement {
  const element = new FakeElement()
  element.className = className
  return element
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('shouldForceCopyOnSelectMouseSelection', () => {
  it('forces selection for plain primary mousedown in TUI mouse mode when copy-on-select is enabled', () => {
    expect(
      shouldForceCopyOnSelectMouseSelection(mouseEvent(), {
        copyOnSelect: true,
        isMac: false,
        mouseTrackingMode: 'drag'
      })
    ).toBe(true)
  })

  it('does not force selection when copy-on-select is disabled', () => {
    expect(
      shouldForceCopyOnSelectMouseSelection(mouseEvent(), {
        copyOnSelect: false,
        isMac: false,
        mouseTrackingMode: 'drag'
      })
    ).toBe(false)
  })

  it('does not force selection when the TUI is not using mouse mode', () => {
    expect(
      shouldForceCopyOnSelectMouseSelection(mouseEvent(), {
        copyOnSelect: true,
        isMac: false,
        mouseTrackingMode: 'none'
      })
    ).toBe(false)
  })

  it('leaves non-primary buttons and existing modified clicks alone', () => {
    const options = { copyOnSelect: true, isMac: false, mouseTrackingMode: 'drag' } as const

    expect(shouldForceCopyOnSelectMouseSelection(mouseEvent({ button: 1 }), options)).toBe(false)
    expect(shouldForceCopyOnSelectMouseSelection(mouseEvent({ ctrlKey: true }), options)).toBe(
      false
    )
    expect(shouldForceCopyOnSelectMouseSelection(mouseEvent({ metaKey: true }), options)).toBe(
      false
    )
    expect(shouldForceCopyOnSelectMouseSelection(mouseEvent({ shiftKey: true }), options)).toBe(
      false
    )
  })

  it('does not force selection after another handler prevents the event', () => {
    expect(
      shouldForceCopyOnSelectMouseSelection(mouseEvent({ defaultPrevented: true }), {
        copyOnSelect: true,
        isMac: false,
        mouseTrackingMode: 'drag'
      })
    ).toBe(false)
  })

  it('uses Option as the existing force-selection modifier on macOS', () => {
    expect(
      shouldForceCopyOnSelectMouseSelection(mouseEvent({ altKey: true }), {
        copyOnSelect: true,
        isMac: true,
        mouseTrackingMode: 'drag'
      })
    ).toBe(false)
    expect(
      shouldForceCopyOnSelectMouseSelection(mouseEvent({ shiftKey: true }), {
        copyOnSelect: true,
        isMac: true,
        mouseTrackingMode: 'drag'
      })
    ).toBe(true)
  })
})

describe('isXtermScreenMouseTarget', () => {
  it('matches events inside the xterm screen only', () => {
    installDomGlobals()
    const outside = fakeElement()
    const screen = fakeElement('xterm-screen')
    const row = fakeElement()
    screen.appendChild(row)

    expect(isXtermScreenMouseTarget(outside as never)).toBe(false)
    expect(isXtermScreenMouseTarget(screen as never)).toBe(true)
    expect(isXtermScreenMouseTarget(row as never)).toBe(true)
  })
})

describe('createForcedSelectionMouseEvent', () => {
  it('adds Shift on Windows/Linux', () => {
    installDomGlobals()
    const event = new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10 })
    const forced = createForcedSelectionMouseEvent(event, false)

    expect(forced.shiftKey).toBe(true)
    expect(forced.altKey).toBe(false)
    expect(forced.button).toBe(0)
    expect(forced.clientX).toBe(10)
  })

  it('adds Option on macOS', () => {
    installDomGlobals()
    const event = new MouseEvent('mousedown', { bubbles: true, button: 0, shiftKey: false })
    const forced = createForcedSelectionMouseEvent(event, true)

    expect(forced.altKey).toBe(true)
    expect(forced.shiftKey).toBe(false)
  })
})

describe('installCopyOnSelectMouseSelectionForcing', () => {
  it('redispatches a force-selection mouse event and stops the original event', () => {
    installDomGlobals()
    const container = fakeElement()
    const screen = fakeElement('xterm-screen')
    const target = fakeElement()
    screen.appendChild(target)
    container.appendChild(screen)
    const seenShiftStates: boolean[] = []
    target.addEventListener('mousedown', (event) => {
      seenShiftStates.push(event.shiftKey)
    })
    const dispose = installCopyOnSelectMouseSelectionForcing({
      container: container as never,
      getCopyOnSelect: () => true,
      isMac: false,
      terminal: { modes: { mouseTrackingMode: 'drag' } } as never
    })

    target.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }) as never
    )

    expect(seenShiftStates).toEqual([true])
    dispose()
  })

  it('does not redispatch when copy-on-select is off', () => {
    installDomGlobals()
    const container = fakeElement()
    const screen = fakeElement('xterm-screen')
    const target = fakeElement()
    screen.appendChild(target)
    container.appendChild(screen)
    const listener = vi.fn()
    target.addEventListener('mousedown', listener)
    const dispose = installCopyOnSelectMouseSelectionForcing({
      container: container as never,
      getCopyOnSelect: () => false,
      isMac: false,
      terminal: { modes: { mouseTrackingMode: 'drag' } } as never
    })

    target.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }) as never
    )

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0].shiftKey).toBe(false)
    dispose()
  })

  it('does not redispatch outside the xterm screen', () => {
    installDomGlobals()
    const container = fakeElement()
    const target = fakeElement()
    container.appendChild(target)
    const listener = vi.fn()
    target.addEventListener('mousedown', listener)
    const dispose = installCopyOnSelectMouseSelectionForcing({
      container: container as never,
      getCopyOnSelect: () => true,
      isMac: false,
      terminal: { modes: { mouseTrackingMode: 'drag' } } as never
    })

    target.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }) as never
    )

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0].shiftKey).toBe(false)
    dispose()
  })
})
