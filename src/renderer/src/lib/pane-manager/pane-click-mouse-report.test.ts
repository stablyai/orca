// @vitest-environment happy-dom
// Drives a real PaneManager and a real xterm so the gate is measured on the
// bytes a click actually sends, not on the option value alone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from './pane-manager-types'
import { getDefaultSettings } from '../../../../shared/constants'
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
function stubLayout(): () => void {
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
  // Why the descriptors: vi.restoreAllMocks() only unwinds spies, so a prototype
  // redefinition would outlive the suite.
  const originalDescriptors = new Map<string, PropertyDescriptor | undefined>()
  for (const prop of ['offsetWidth', 'offsetHeight'] as const) {
    originalDescriptors.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop))
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
  return () => {
    for (const [prop, descriptor] of originalDescriptors) {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, prop, descriptor)
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop]
      }
    }
  }
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

function dispatchMouse(target: EventTarget, type: string, altKey: boolean): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 40,
      clientY: 40,
      altKey
    })
  )
}

// One physical click = pane-container pointerdown, then mousedown/mouseup on xterm.
function clickPane(pane: ManagedPane, altKey = false): void {
  dispatchMouse(pane.container, 'pointerdown', altKey)
  const element = terminalElement(pane)
  dispatchMouse(element, 'mousedown', altKey)
  dispatchMouse(element, 'mouseup', altKey)
}

describe('clicking a pane whose TUI tracks the mouse', () => {
  let root: HTMLElement
  let manager: PaneManager
  let restoreLayout: () => void
  let originalResizeObserver: PropertyDescriptor | undefined

  beforeEach(() => {
    originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub
    restoreLayout = stubLayout()
    root = document.createElement('div')
    document.body.appendChild(root)
    manager = new PaneManager(root, { linkOpenHint: () => '' })
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    vi.restoreAllMocks()
    restoreLayout()
    if (originalResizeObserver) {
      Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver)
    } else {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    }
  })

  // Why not applyTerminalAppearance: it repaints, and xterm's renderer needs a real
  // canvas. The settings-to-option half is covered by terminal-mouse-events-require-alt.
  async function trackingPane(
    requireAlt: boolean
  ): Promise<{ pane: ManagedPane; toPty: string[] }> {
    const pane = manager.createInitialPane()
    stubPanePadding(pane)
    pane.terminal.options.mouseEventsRequireAlt = requireAlt
    await new Promise<void>((resolve) =>
      pane.terminal.write(ENABLE_MOUSE_TRACKING, () => resolve())
    )
    expect(pane.terminal.modes.mouseTrackingMode).not.toBe('none')
    const toPty: string[] = []
    pane.terminal.onData((data) => toPty.push(data))
    return { pane, toPty }
  }

  // Why sourced from the default: flipping constants.ts would otherwise gate every
  // new profile's clicks with only a settings-object assertion to catch it.
  it('reports the click under the shipped default', async () => {
    const { pane, toPty } = await trackingPane(
      getDefaultSettings('/tmp').terminalMouseEventsRequireAlt === true
    )

    clickPane(pane)

    expect(toPty.join('')).toMatch(SGR_MOUSE_REPORT)
  })

  it('reports nothing once the setting is on', async () => {
    const { pane, toPty } = await trackingPane(true)

    clickPane(pane)

    expect(toPty.join('')).not.toMatch(SGR_MOUSE_REPORT)
  })

  it('still reports an alt-held click once the setting is on', async () => {
    const { pane, toPty } = await trackingPane(true)

    clickPane(pane, true)

    expect(toPty.join('')).toMatch(SGR_MOUSE_REPORT)
  })
})
