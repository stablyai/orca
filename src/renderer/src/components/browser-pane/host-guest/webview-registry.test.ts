import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const viewportMocks = vi.hoisted(() => ({
  clearBrowserPageViewportPresetSize: vi.fn(),
  removeBrowserPageViewport: vi.fn()
}))

vi.mock('./browser-page-viewport', () => viewportMocks)

type ListenerRecord = {
  type: string
  listener: EventListenerOrEventListenerObject
  options?: boolean | AddEventListenerOptions
}

function createWebview(overrides: Partial<Electron.WebviewTag> = {}): Electron.WebviewTag {
  return Object.assign(new EventTarget(), {
    style: {},
    blur: vi.fn(),
    remove: vi.fn(),
    contains: vi.fn(() => false),
    ...overrides
  }) as unknown as Electron.WebviewTag
}

describe('webview registry drag listeners', () => {
  let addedListeners: ListenerRecord[]
  let removedListeners: ListenerRecord[]
  let unregisterGuestMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    addedListeners = []
    removedListeners = []
    unregisterGuestMock = vi.fn()
    viewportMocks.removeBrowserPageViewport.mockReset()
    viewportMocks.clearBrowserPageViewportPresetSize.mockReset()

    vi.stubGlobal('window', {
      addEventListener: vi.fn(
        (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions
        ) => {
          addedListeners.push({ type, listener, options })
        }
      ),
      removeEventListener: vi.fn(
        (
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions
        ) => {
          removedListeners.push({ type, listener, options })
        }
      ),
      focus: vi.fn(),
      api: {
        browser: {
          unregisterGuest: unregisterGuestMock
        }
      }
    })
    vi.stubGlobal('document', { activeElement: null })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('releases native drag passthrough when a cancelled dragstart never starts a drag', async () => {
    const { registerPersistentWebview } = await import('./webview-registry')
    const webview = createWebview()
    webview.style.pointerEvents = 'auto'
    registerPersistentWebview('page-1', webview)
    const listener = (type: string): ((event: Event) => void) => {
      const found = addedListeners.find((entry) => entry.type === type)?.listener
      if (typeof found !== 'function') {
        throw new Error(`${type} listener missing`)
      }
      return found
    }

    for (const pointerType of ['pointermove', 'pointerdown']) {
      listener('dragstart')(new Event('dragstart'))
      expect(webview.style.pointerEvents).toBe('none')
      // No dragend or drop follows a cancelled dragstart; the next pointer event proves no drag is live.
      listener(pointerType)(new Event(pointerType))
      expect(webview.style.pointerEvents).toBe('auto')
    }
  })

  it('keeps webviews in passthrough until every renderer drag releases', async () => {
    const { acquireWebviewsDragPassthrough, registerPersistentWebview } =
      await import('./webview-registry')
    const activeWebview = createWebview()
    activeWebview.style.pointerEvents = 'auto'
    const lockedWebview = createWebview()
    lockedWebview.style.pointerEvents = 'none'
    registerPersistentWebview('page-1', activeWebview)
    registerPersistentWebview('page-2', lockedWebview)

    const releaseFirstDrag = acquireWebviewsDragPassthrough()
    const releaseSecondDrag = acquireWebviewsDragPassthrough()

    expect(activeWebview.style.pointerEvents).toBe('none')
    expect(lockedWebview.style.pointerEvents).toBe('none')

    releaseFirstDrag()

    expect(activeWebview.style.pointerEvents).toBe('none')
    expect(lockedWebview.style.pointerEvents).toBe('none')

    releaseSecondDrag()
    releaseSecondDrag()

    expect(activeWebview.style.pointerEvents).toBe('auto')
    expect(lockedWebview.style.pointerEvents).toBe('none')
  })

  it('applies active passthrough to webviews registered mid-drag', async () => {
    const { acquireWebviewsDragPassthrough, registerPersistentWebview } =
      await import('./webview-registry')
    const releaseDrag = acquireWebviewsDragPassthrough()
    const webview = createWebview()
    webview.style.pointerEvents = 'auto'

    registerPersistentWebview('page-1', webview)

    expect(webview.style.pointerEvents).toBe('none')

    releaseDrag()

    expect(webview.style.pointerEvents).toBe('auto')
  })
})
