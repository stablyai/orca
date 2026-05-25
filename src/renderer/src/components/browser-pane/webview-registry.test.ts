import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ListenerRecord = {
  type: string
  listener: EventListenerOrEventListenerObject
  options?: boolean | AddEventListenerOptions
}

function createWebview(overrides: Partial<Electron.WebviewTag> = {}): Electron.WebviewTag {
  return {
    style: {},
    blur: vi.fn(),
    remove: vi.fn(),
    contains: vi.fn(() => false),
    ...overrides
  } as unknown as Electron.WebviewTag
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

  it('does not install global drag listeners until a webview is registered', async () => {
    const { registerPersistentWebview } = await import('./webview-registry')

    expect(addedListeners).toEqual([])

    registerPersistentWebview('page-1', createWebview())

    expect(addedListeners.map((entry) => entry.type)).toEqual(['dragstart', 'dragend', 'drop'])
  })

  it('removes drag listeners after the last webview is destroyed', async () => {
    const { destroyPersistentWebview, registerPersistentWebview } =
      await import('./webview-registry')

    registerPersistentWebview('page-1', createWebview())
    registerPersistentWebview('page-2', createWebview())

    expect(addedListeners).toHaveLength(3)

    destroyPersistentWebview('page-1')

    expect(removedListeners).toHaveLength(0)

    destroyPersistentWebview('page-2')

    expect(removedListeners.map((entry) => entry.type)).toEqual(['dragstart', 'dragend', 'drop'])
    expect(unregisterGuestMock).toHaveBeenCalledWith({ browserPageId: 'page-1' })
    expect(unregisterGuestMock).toHaveBeenCalledWith({ browserPageId: 'page-2' })
  })

  it('releases native drag passthrough when the last webview is destroyed', async () => {
    const { destroyPersistentWebview, registerPersistentWebview } =
      await import('./webview-registry')
    const firstWebview = createWebview()
    firstWebview.style.pointerEvents = 'auto'
    registerPersistentWebview('page-1', firstWebview)

    const dragStart = addedListeners.find((entry) => entry.type === 'dragstart')?.listener
    if (typeof dragStart === 'function') {
      dragStart(new Event('dragstart'))
    } else {
      throw new Error('dragstart listener missing')
    }

    expect(firstWebview.style.pointerEvents).toBe('none')

    destroyPersistentWebview('page-1')

    const secondWebview = createWebview()
    secondWebview.style.pointerEvents = 'auto'
    registerPersistentWebview('page-2', secondWebview)

    expect(secondWebview.style.pointerEvents).toBe('auto')
  })

  it('keeps one listener set across repeated registrations', async () => {
    const { registerPersistentWebview } = await import('./webview-registry')

    registerPersistentWebview('page-1', createWebview())
    registerPersistentWebview('page-2', createWebview())

    expect(addedListeners).toHaveLength(3)
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

  it('moves focus back to the renderer before detaching the focused webview', async () => {
    const { moveFocusToRendererBeforeWebviewDetach } = await import('./webview-registry')
    const webview = createWebview()
    vi.stubGlobal('document', { activeElement: webview })

    moveFocusToRendererBeforeWebviewDetach(webview)

    expect(webview.blur).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
  })

  it('moves focus back to the renderer before detaching a webview that contains focus', async () => {
    const { moveFocusToRendererBeforeWebviewDetach } = await import('./webview-registry')
    const activeElement = { blur: vi.fn() } as unknown as HTMLElement
    const webview = createWebview({ contains: vi.fn(() => true) })
    vi.stubGlobal('document', { activeElement })

    moveFocusToRendererBeforeWebviewDetach(webview)

    expect(activeElement.blur).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
  })

  it('moves focus back to the renderer before a focused registered webview is hidden', async () => {
    const { moveFocusToRendererBeforeFocusedWebviewHidden, registerPersistentWebview } =
      await import('./webview-registry')
    const inactiveWebview = createWebview()
    const focusedWebview = createWebview()
    vi.stubGlobal('document', { activeElement: focusedWebview })

    registerPersistentWebview('page-1', inactiveWebview)
    registerPersistentWebview('page-2', focusedWebview)

    moveFocusToRendererBeforeFocusedWebviewHidden()

    expect(inactiveWebview.blur).not.toHaveBeenCalled()
    expect(focusedWebview.blur).toHaveBeenCalledTimes(1)
    expect(window.focus).toHaveBeenCalledTimes(1)
  })

  it('leaves focus alone before detaching an unfocused webview', async () => {
    const { moveFocusToRendererBeforeWebviewDetach } = await import('./webview-registry')
    const activeElement = { blur: vi.fn() } as unknown as HTMLElement
    const webview = createWebview()
    vi.stubGlobal('document', { activeElement })

    moveFocusToRendererBeforeWebviewDetach(webview)

    expect(activeElement.blur).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
  })
})
