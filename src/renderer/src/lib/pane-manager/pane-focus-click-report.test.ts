// @vitest-environment happy-dom
// Drives a real PaneManager and a real xterm so the fix is measured on the bytes
// a focusing click sends, not on the predicate alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from './pane-manager-types'
import { PaneManager } from './pane-manager'

const ESC = '\u001b'
const SGR_MOUSE_REPORT = new RegExp(`${ESC}\\[<\\d+;\\d+;\\d+[Mm]`)
// The combination a mouse-aware TUI turns on: button events, drag, SGR encoding.
const ENABLE_MOUSE_TRACKING = `${ESC}[?1000h${ESC}[?1002h${ESC}[?1006h`

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// happy-dom performs no layout, so xterm measures every cell as 0 and cannot map
// a click to a cell. Fill in only the boxes that measurement reads.
function stubLayout(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: () => ({ width: 10 }),
    clearRect: () => {},
    fillRect: () => {},
    setTransform: () => {},
    scale: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} })
  } as unknown as CanvasRenderingContext2D)
  for (const prop of ['offsetWidth', 'offsetHeight'] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => (prop === 'offsetWidth' ? 800 : 600)
    })
  }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({})
  } as DOMRect)
}

function terminalElement(pane: ManagedPane): HTMLElement {
  const element = pane.terminal.element
  if (!element) {
    throw new Error('terminal element was not created')
  }
  return element
}

function stubPanePadding(pane: ManagedPane): void {
  const element = terminalElement(pane)
  element.style.padding = '0px'
  ;(element.querySelector('.xterm-screen') as HTMLElement | null)?.style.setProperty(
    'padding',
    '0px'
  )
}

function dispatchMouse(target: EventTarget, type: string): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 40,
      clientY: 40
    })
  )
}

// happy-dom has no PointerEvent, and the suppression reads pointer fields.
function dispatchPointerDown(target: EventTarget): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: 40,
    clientY: 40
  })
  Object.defineProperties(event, {
    pointerType: { value: 'mouse' },
    isPrimary: { value: true }
  })
  target.dispatchEvent(event)
}

// One physical click = pane-container pointerdown, then mousedown/mouseup on xterm.
function clickPane(pane: ManagedPane): void {
  dispatchPointerDown(pane.container)
  const element = terminalElement(pane)
  dispatchMouse(element, 'mousedown')
  dispatchMouse(element, 'mouseup')
}

describe('the click that reactivates a pane', () => {
  let root: HTMLElement
  let manager: PaneManager

  beforeEach(() => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub
    stubLayout()
    root = document.createElement('div')
    document.body.appendChild(root)
    manager = new PaneManager(root, { linkOpenHint: () => '' })
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    vi.restoreAllMocks()
  })

  async function twoPanes(trackMouse: boolean): Promise<{ target: ManagedPane; toPty: string[] }> {
    const target = manager.createInitialPane()
    const other = manager.splitPane(target.id, 'vertical')
    if (!other) {
      throw new Error('split failed')
    }
    stubPanePadding(target)
    if (trackMouse) {
      await new Promise<void>((resolve) =>
        target.terminal.write(ENABLE_MOUSE_TRACKING, () => resolve())
      )
      expect(target.terminal.modes.mouseTrackingMode).not.toBe('none')
    }
    manager.setActivePane(other.id)
    const toPty: string[] = []
    target.terminal.onData((data) => toPty.push(data))
    return { target, toPty }
  }

  it('sends no mouse report while a TUI tracks the mouse', async () => {
    const { target, toPty } = await twoPanes(true)

    clickPane(target)

    expect(manager.getActivePane()?.id).toBe(target.id)
    expect(toPty.join('')).not.toMatch(SGR_MOUSE_REPORT)
  })

  it('still reports a click once the pane is already active', async () => {
    const { target, toPty } = await twoPanes(true)
    clickPane(target)
    toPty.length = 0

    clickPane(target)

    expect(toPty.join('')).toMatch(SGR_MOUSE_REPORT)
  })

  // Why documented: with focus-follows-mouse the hover already activated the pane,
  // so the click is deliberate rather than a focus grab and must reach the TUI.
  it('reports the click when hover already activated the pane', async () => {
    const { target, toPty } = await twoPanes(true)
    manager.setActivePane(target.id)

    clickPane(target)

    expect(toPty.join('')).toMatch(SGR_MOUSE_REPORT)
  })

  it('leaves a pane without mouse tracking alone', async () => {
    const { target, toPty } = await twoPanes(false)

    clickPane(target)

    expect(manager.getActivePane()?.id).toBe(target.id)
    expect(toPty.join('')).not.toMatch(SGR_MOUSE_REPORT)
  })
})
