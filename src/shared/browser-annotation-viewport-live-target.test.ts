import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX,
  BROWSER_GRAB_SELECTED_ATTRIBUTE,
  buildBrowserAnnotationViewportBridgeScript
} from './browser-annotation-viewport-bridge'
import {
  parseBrowserAnnotationViewportReport,
  type BrowserAnnotationViewportReport
} from './browser-annotation-viewport-report'

type Rect = { x: number; y: number; width: number; height: number }

const TOKEN = 'live-target-test-token'
const guestAborts: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(guestAborts.splice(0).map((abort) => abort()))
})

async function createGuest(targetIsRoot = false) {
  const { Window } = await import('happy-dom')
  const window = new Window({ width: 1000, height: 800 })
  guestAborts.push(() => window.happyDOM.abort())
  const document = window.document
  const scroller = document.createElement('div')
  const target = targetIsRoot ? document.documentElement : document.createElement('section')
  if (!targetIsRoot) {
    scroller.appendChild(target)
    document.body.appendChild(scroller)
  }
  let targetRect: Rect = { x: 40, y: 300, width: 120, height: 30 }
  const contentSize = { width: 120, height: 30 }
  const rootSize = { width: 1000, height: 800 }
  const spacing = { padding: 0, border: 0 }
  target.getBoundingClientRect = () =>
    new window.DOMRect(targetRect.x, targetRect.y, targetRect.width, targetRect.height)

  const frames: (() => void)[] = []
  const resizeCallbacks: (() => void)[] = []
  const observers: {
    callback: () => void
    boxes: Map<unknown, { box: 'content-box' | 'border-box'; width: number; height: number }>
  }[] = []
  const measure = (element: unknown, box: 'content-box' | 'border-box') => {
    if (element === target) {
      const spacingSize = box === 'border-box' ? 2 * (spacing.padding + spacing.border) : 0
      return { width: contentSize.width + spacingSize, height: contentSize.height + spacingSize }
    }
    return { ...rootSize }
  }
  const reports: BrowserAnnotationViewportReport[] = []
  const prefix = `${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}${TOKEN}:`
  const context = {
    window,
    document,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      private boxes = new Map<
        unknown,
        { box: 'content-box' | 'border-box'; width: number; height: number }
      >()
      constructor(callback: () => void) {
        resizeCallbacks.push(callback)
        observers.push({ callback, boxes: this.boxes })
      }
      observe(element: unknown, options?: { box?: 'content-box' | 'border-box' }): void {
        const box = options?.box ?? 'content-box'
        this.boxes.set(element, { box, ...measure(element, box) })
      }
      disconnect(): void {
        this.boxes.clear()
      }
    },
    console: {
      debug: (message: string) => {
        const report = parseBrowserAnnotationViewportReport(message.slice(prefix.length))
        if (message.startsWith(prefix) && report) {
          reports.push(report)
        }
      }
    }
  }
  const install = (emitViewport: boolean, selectionId = 'selection-1'): void => {
    runInNewContext(
      buildBrowserAnnotationViewportBridgeScript({
        emitViewport,
        enabled: true,
        token: TOKEN,
        markers: [],
        selectionId
      }),
      context
    )
  }
  const flushFrames = (): void => {
    for (const frame of frames.splice(0)) {
      frame()
    }
  }
  return {
    window,
    scroller,
    target,
    install,
    flushFrames,
    resizeCallbacks,
    notifyResizes: () => {
      let notifications = 0
      for (const observer of observers) {
        let changed = false
        for (const [element, previous] of observer.boxes) {
          const current = measure(element, previous.box)
          if (current.width !== previous.width || current.height !== previous.height) {
            observer.boxes.set(element, { box: previous.box, ...current })
            changed = true
          }
        }
        if (changed) {
          observer.callback()
          notifications++
        }
      }
      return notifications
    },
    setTargetSpacing: (padding: number, border: number) => {
      spacing.padding = padding
      spacing.border = border
      targetRect = {
        ...targetRect,
        width: contentSize.width + 2 * (padding + border),
        height: contentSize.height + 2 * (padding + border)
      }
    },
    setRootContentSize: (width: number, height: number) => {
      rootSize.width = width
      rootSize.height = height
    },
    lastReport: () => reports.at(-1),
    moveTarget: (rect: Rect) => {
      targetRect = rect
    }
  }
}

describe('annotation viewport bridge live target', () => {
  it.each([
    ['border', 0, 8],
    ['padding', 8, 0]
  ])('reports %s-only outer growth with a fixed content box', async (_kind, padding, border) => {
    const guest = await createGuest()
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
    guest.install(true)
    guest.flushFrames()
    guest.setTargetSpacing(padding, border)

    expect(guest.notifyResizes()).toBe(1)
    guest.flushFrames()

    expect(guest.lastReport()?.target).toEqual({ x: 40, y: 300, width: 136, height: 46 })
  })

  it('keeps a selected document root on outer-box observation', async () => {
    const guest = await createGuest(true)
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
    guest.install(true)
    guest.flushFrames()
    guest.setTargetSpacing(0, 8)

    expect(guest.notifyResizes()).toBe(1)
    guest.flushFrames()

    expect(guest.lastReport()?.target).toEqual({ x: 40, y: 300, width: 136, height: 46 })
  })

  it('re-reports when the document root content box changes', async () => {
    const guest = await createGuest()
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
    guest.install(true)
    guest.flushFrames()
    guest.moveTarget({ x: 40, y: 250, width: 120, height: 30 })
    guest.setRootContentSize(980, 800)

    expect(guest.notifyResizes()).toBe(1)
    guest.flushFrames()

    expect(guest.lastReport()?.target).toEqual({ x: 40, y: 250, width: 120, height: 30 })
  })

  it('reports the selected element measured live, including scroll inside a box', async () => {
    const guest = await createGuest()
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
    guest.install(true)
    guest.flushFrames()
    expect(guest.lastReport()).toEqual({
      scrollX: 0,
      scrollY: 0,
      viewportWidth: 1000,
      target: { x: 40, y: 300, width: 120, height: 30 }
    })

    // A box scrolling inside the page leaves window scroll unchanged.
    guest.moveTarget({ x: 40, y: 120, width: 120, height: 30 })
    guest.scroller.dispatchEvent(new guest.window.Event('scroll'))
    guest.flushFrames()
    expect(guest.lastReport()?.target).toEqual({ x: 40, y: 120, width: 120, height: 30 })
  })

  it('ignores an earlier page-owned selection marker', async () => {
    const guest = await createGuest()
    const decoy = guest.window.document.createElement('div')
    decoy.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'page-owned')
    decoy.getBoundingClientRect = () => new guest.window.DOMRect(600, 400, 40, 20)
    guest.window.document.body.insertBefore(decoy, guest.scroller)
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')

    guest.install(true)
    guest.flushFrames()

    expect(guest.lastReport()?.target).toEqual({ x: 40, y: 300, width: 120, height: 30 })
  })

  it('switches to a new selection when the bridge is reused', async () => {
    const guest = await createGuest()
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
    guest.install(true)
    guest.flushFrames()

    const next = guest.window.document.createElement('button')
    next.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-2')
    next.getBoundingClientRect = () => new guest.window.DOMRect(200, 100, 80, 20)
    guest.window.document.body.appendChild(next)
    guest.install(true, 'selection-2')
    guest.flushFrames()

    expect(guest.lastReport()?.target).toEqual({ x: 200, y: 100, width: 80, height: 20 })
  })

  it('does not report a target when two elements copy the same selection value', async () => {
    const guest = await createGuest()
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
    const decoy = guest.window.document.createElement('div')
    decoy.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
    guest.window.document.body.insertBefore(decoy, guest.scroller)

    guest.install(true)
    guest.flushFrames()

    expect(guest.lastReport()).toEqual({ scrollX: 0, scrollY: 0, viewportWidth: 1000 })
  })

  it('re-reports on resize and when the element changes size', async () => {
    const guest = await createGuest()
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
    guest.install(true)
    guest.flushFrames()

    guest.moveTarget({ x: 10, y: 200, width: 80, height: 30 })
    guest.window.dispatchEvent(new guest.window.Event('resize'))
    guest.flushFrames()
    expect(guest.lastReport()?.target).toEqual({ x: 10, y: 200, width: 80, height: 30 })

    guest.moveTarget({ x: 10, y: 200, width: 80, height: 90 })
    for (const callback of guest.resizeCallbacks) {
      callback()
    }
    guest.flushFrames()
    expect(guest.lastReport()?.target).toEqual({ x: 10, y: 200, width: 80, height: 90 })
  })

  it('reports no target once the grab overlay has released the element', async () => {
    const guest = await createGuest()
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
    guest.install(true)
    guest.flushFrames()

    guest.target.removeAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE)
    guest.window.dispatchEvent(new guest.window.Event('scroll'))
    guest.flushFrames()
    expect(guest.lastReport()).toEqual({ scrollX: 0, scrollY: 0, viewportWidth: 1000 })
  })
})

describe('parseBrowserAnnotationViewportReport', () => {
  it('keeps only well-formed numbers and boxes', () => {
    expect(
      parseBrowserAnnotationViewportReport(
        JSON.stringify({ scrollX: 'x', scrollY: 4, viewportWidth: -1, target: { x: 1 } })
      )
    ).toEqual({ scrollX: 0, scrollY: 4 })
    expect(parseBrowserAnnotationViewportReport('not json')).toBeNull()
    expect(parseBrowserAnnotationViewportReport('7')).toBeNull()
  })
})
