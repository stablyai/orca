import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type ListenerRecord = {
  type: string
  listener: EventListenerOrEventListenerObject
  options?: boolean | AddEventListenerOptions
}

function createWebview(): Electron.WebviewTag {
  return {
    style: {},
    remove: vi.fn(),
    contains: vi.fn(() => false)
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

  it('keeps one listener set across repeated registrations', async () => {
    const { registerPersistentWebview } = await import('./webview-registry')

    registerPersistentWebview('page-1', createWebview())
    registerPersistentWebview('page-2', createWebview())

    expect(addedListeners).toHaveLength(3)
  })
})
