// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: happy-dom has no canvas, so xterm cannot open; the gestures never touch the terminal.
vi.mock('./pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

const { PaneManager } = await import('./pane-manager')

function pointer(type: string, init: { clientX?: number; clientY?: number } = {}): Event {
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    button: 0,
    ctrlKey: false,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0
  })
}

function capturable(element: Element | null): HTMLElement {
  if (!(element instanceof HTMLElement)) {
    throw new Error('gesture element is not mounted')
  }
  const captured = new Set<number>()
  element.setPointerCapture = (id) => void captured.add(id)
  element.releasePointerCapture = (id) => void captured.delete(id)
  element.hasPointerCapture = (id) => captured.has(id)
  return element
}

// A host snapshot or late terminal attach can move focus between panes mid-gesture; only the
// window losing focus may end it.
describe('pane gestures and focus changes inside the window', () => {
  let root: HTMLDivElement
  let manager: InstanceType<typeof PaneManager>
  let inputs: HTMLTextAreaElement[]

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    root = document.createElement('div')
    document.body.appendChild(root)
    manager = new PaneManager(root, { linkOpenHint: () => '' })
    const first = manager.createInitialPane()
    const second = manager.splitPane(first.id, 'vertical')
    inputs = [first, second!].map((pane) => {
      const input = document.createElement('textarea')
      pane.container.appendChild(input)
      return input
    })
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    vi.unstubAllGlobals()
  })

  it('a pane drag survives focus moving to another pane and ends when the window blurs', () => {
    const handle = capturable(root.querySelector('.pane-drag-handle'))
    inputs[0].focus()

    handle.dispatchEvent(pointer('pointerdown'))
    handle.dispatchEvent(pointer('pointermove', { clientY: 20 }))
    expect(root.querySelector('.is-pane-dragging, .is-drag-source')).not.toBeNull()

    inputs[1].focus()
    expect(root.querySelector('.is-drag-source')).not.toBeNull()

    window.dispatchEvent(new Event('blur'))
    expect(root.querySelector('.is-drag-source')).toBeNull()
  })

  it('a divider drag survives focus moving to another pane and ends when the window blurs', () => {
    const divider = capturable(root.querySelector('.pane-divider'))
    for (const sibling of [divider.previousElementSibling, divider.nextElementSibling]) {
      if (sibling instanceof HTMLElement) {
        sibling.getBoundingClientRect = () => DOMRect.fromRect({ width: 200, height: 100 })
      }
    }
    inputs[0].focus()

    divider.dispatchEvent(pointer('pointerdown', { clientX: 200 }))
    expect(divider.classList.contains('is-dragging')).toBe(true)

    inputs[1].focus()
    expect(divider.classList.contains('is-dragging')).toBe(true)

    window.dispatchEvent(new Event('blur'))
    expect(divider.classList.contains('is-dragging')).toBe(false)
  })
})
