// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneExternalDropHandler, PaneExternalDropTarget } from './pane-manager-types'

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

function key(
  type: 'keydown' | 'keyup',
  init: { key?: string; code?: string; repeat?: boolean; isComposing?: boolean } = {}
): KeyboardEvent {
  return new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    key: init.key ?? 'Escape',
    code: init.code ?? 'Escape',
    repeat: init.repeat ?? false,
    isComposing: init.isComposing ?? false
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

const STRIP_TARGET: PaneExternalDropTarget = {
  id: 'group-1',
  rect: DOMRect.fromRect({ x: 0, y: 0, width: 200, height: 30 })
}

describe('Escape during a pane drag', () => {
  let root: HTMLDivElement
  let manager: InstanceType<typeof PaneManager>
  let terminalInput: HTMLTextAreaElement
  let terminalKeys: string[]
  let onExternalPaneDrop: ReturnType<typeof vi.fn<PaneExternalDropHandler>>

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    root = document.createElement('div')
    document.body.appendChild(root)
    onExternalPaneDrop = vi.fn<PaneExternalDropHandler>(() => true)
    manager = new PaneManager(root, {
      linkOpenHint: () => '',
      resolveExternalPaneDropTarget: () => STRIP_TARGET,
      onExternalPaneDrop
    })
    const first = manager.createInitialPane()
    manager.splitPane(first.id, 'vertical')
    terminalInput = document.createElement('textarea')
    first.container.appendChild(terminalInput)
    terminalKeys = []
    // Stands in for xterm's textarea handlers, which write to the PTY.
    for (const type of ['keydown', 'keyup'] as const) {
      terminalInput.addEventListener(type, (event) => {
        terminalKeys.push(`${type}:${event.key}${event.repeat ? ':repeat' : ''}`)
      })
    }
    terminalInput.focus()
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    vi.unstubAllGlobals()
  })

  function startDrag(): HTMLElement {
    const handle = capturable(root.querySelector('.pane-drag-handle'))
    handle.dispatchEvent(pointer('pointerdown'))
    handle.dispatchEvent(pointer('pointermove', { clientX: 40, clientY: 20 }))
    expect(root.querySelector('.is-drag-source')).not.toBeNull()
    return handle
  }

  it('drops onto the strip when released without Escape', () => {
    const handle = startDrag()
    handle.dispatchEvent(pointer('pointerup', { clientX: 40, clientY: 20 }))
    expect(onExternalPaneDrop).toHaveBeenCalledTimes(1)
  })

  it('cancels the drag, keeps the key from the terminal, and ignores the later release', () => {
    const handle = startDrag()

    const escape = key('keydown')
    terminalInput.dispatchEvent(escape)

    expect(escape.defaultPrevented).toBe(true)
    expect(root.querySelector('.is-pane-dragging, .is-drag-source')).toBeNull()
    // Still captured: the release lands on the handle, not whatever lies under the pointer.
    expect(handle.hasPointerCapture(1)).toBe(true)
    handle.dispatchEvent(pointer('pointermove', { clientX: 60, clientY: 20 }))
    expect(root.querySelector('.is-pane-dragging')).toBeNull()
    handle.dispatchEvent(pointer('pointerup', { clientX: 60, clientY: 20 }))

    expect(onExternalPaneDrop).not.toHaveBeenCalled()
    expect(handle.hasPointerCapture(1)).toBe(false)
    expect(terminalKeys).toEqual([])
  })

  it('swallows the cancelling press through its repeats and release, then lets keys through', () => {
    startDrag()
    terminalInput.dispatchEvent(key('keydown'))
    terminalInput.dispatchEvent(key('keydown', { repeat: true }))
    terminalInput.dispatchEvent(key('keydown', { key: 'a', code: 'KeyA' }))
    terminalInput.dispatchEvent(key('keyup'))
    terminalInput.dispatchEvent(key('keydown'))
    terminalInput.dispatchEvent(key('keyup'))

    expect(terminalKeys).toEqual(['keydown:a', 'keydown:Escape', 'keyup:Escape'])
  })

  it('treats a fresh Escape press as new when the release was missed', () => {
    startDrag()
    terminalInput.dispatchEvent(key('keydown'))
    terminalInput.dispatchEvent(key('keydown'))

    expect(terminalKeys).toEqual(['keydown:Escape'])
  })

  it('stops owning the key when the window loses focus', () => {
    const handle = startDrag()
    terminalInput.dispatchEvent(key('keydown'))
    window.dispatchEvent(new Event('blur'))
    handle.dispatchEvent(pointer('pointerup'))
    terminalInput.dispatchEvent(key('keyup'))

    expect(terminalKeys).toEqual(['keyup:Escape'])
  })

  it('leaves Escape alone before the drag starts and while an IME composes', () => {
    const handle = capturable(root.querySelector('.pane-drag-handle'))
    handle.dispatchEvent(pointer('pointerdown'))
    terminalInput.dispatchEvent(key('keydown'))
    handle.dispatchEvent(pointer('pointermove', { clientX: 40, clientY: 20 }))
    expect(root.querySelector('.is-drag-source')).not.toBeNull()

    terminalInput.dispatchEvent(key('keydown', { isComposing: true }))
    expect(root.querySelector('.is-drag-source')).not.toBeNull()
    handle.dispatchEvent(pointer('pointerup', { clientX: 40, clientY: 20 }))

    expect(onExternalPaneDrop).toHaveBeenCalledTimes(1)
    expect(terminalKeys).toEqual(['keydown:Escape', 'keydown:Escape'])
  })
})
