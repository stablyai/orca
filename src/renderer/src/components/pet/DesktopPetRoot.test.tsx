// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  petSize: 180,
  hydratePersistedUI: vi.fn()
}))

const desktopPetApi = vi.hoisted(() => ({
  onAnimation: vi.fn((_callback: (animation: string) => void) => () => {}),
  requestAnimation: vi.fn(() => Promise.resolve()),
  move: vi.fn(() => Promise.resolve()),
  setInteractive: vi.fn(() => Promise.resolve())
}))

const uiApi = vi.hoisted(() => ({
  onStateChanged: vi.fn((_callback: (ui: unknown) => void) => () => {}),
  get: vi.fn(() => Promise.resolve({}))
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(
    <T,>(selector: (state: typeof storeState) => T): T => selector(storeState),
    { getState: () => storeState }
  )
}))

vi.mock('./usePetUrl', () => ({
  usePetUrl: () => ({ url: 'blob:pet', ready: true, sprite: null, detected: null })
}))

import { DesktopPetRoot } from './DesktopPetRoot'

function render(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<DesktopPetRoot />)
  })
  return { container, root }
}

function petWrapper(container: HTMLDivElement): HTMLElement {
  const wrapper = container.querySelector<HTMLElement>('[style*="grab"]')
  if (!wrapper) {
    throw new Error('pet wrapper not found')
  }
  return wrapper
}

function pointerEvent(type: string, props: Record<string, unknown>): PointerEvent {
  return Object.assign(new Event(type, { bubbles: true }), {
    button: 0,
    pointerId: 1,
    screenX: 0,
    screenY: 0,
    clientX: 0,
    clientY: 0,
    ...props
  }) as PointerEvent
}

describe('DesktopPetRoot', () => {
  beforeEach(() => {
    Object.assign(window, {
      api: { desktopPet: desktopPetApi, ui: uiApi },
      screenX: 300,
      screenY: 200
    })
    Element.prototype.setPointerCapture = vi.fn()
    Element.prototype.hasPointerCapture = vi.fn(() => false)
    Element.prototype.releasePointerCapture = vi.fn()
  })

  afterEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
  })

  it('asks main for the current animation on mount, so a reopened pet is never blank', () => {
    const { root } = render()
    expect(desktopPetApi.requestAnimation).toHaveBeenCalled()
    expect(desktopPetApi.onAnimation).toHaveBeenCalled()
    act(() => root.unmount())
  })

  it('mirrors persisted UI state into its own store so it renders the same pet', () => {
    const { root } = render()
    expect(uiApi.onStateChanged).toHaveBeenCalled()
    expect(uiApi.get).toHaveBeenCalled()
    act(() => root.unmount())
  })

  it('starts click-through, so the transparent corners never swallow a click', () => {
    const { root } = render()
    expect(desktopPetApi.setInteractive).toHaveBeenCalledWith(false)
    act(() => root.unmount())
  })

  it('takes the mouse back once the pointer is over the pet', () => {
    const { container, root } = render()
    const petBox = container.querySelector<HTMLElement>('[data-desktop-pet-hit-area]')!
    petBox.getBoundingClientRect = () => ({ left: 16, top: 16, right: 196, bottom: 196 }) as DOMRect

    act(() => {
      window.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 100, clientY: 100 }))
    })
    expect(desktopPetApi.setInteractive).toHaveBeenLastCalledWith(true)

    act(() => {
      window.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 2, clientY: 2 }))
    })
    expect(desktopPetApi.setInteractive).toHaveBeenLastCalledWith(false)
    act(() => root.unmount())
  })

  it('translates a drag into an absolute window move in screen coordinates', () => {
    const { container, root } = render()
    const wrapper = petWrapper(container)

    act(() => {
      wrapper.dispatchEvent(pointerEvent('pointerdown', { screenX: 350, screenY: 260 }))
    })
    act(() => {
      wrapper.dispatchEvent(pointerEvent('pointermove', { screenX: 400, screenY: 300 }))
    })

    // Grabbed 50/60 into a window at (300, 200); the same grip at (400, 300) puts it at (350, 240).
    expect(desktopPetApi.move).toHaveBeenLastCalledWith({ x: 350, y: 240 })
    act(() => root.unmount())
  })
})
