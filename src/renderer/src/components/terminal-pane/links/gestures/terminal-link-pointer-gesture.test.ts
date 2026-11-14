// @vitest-environment happy-dom
import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTerminalLinkPointerGesture } from './terminal-link-pointer-gesture'

const activeGestures = new Set<ReturnType<typeof installTerminalLinkPointerGesture>>()

function createGesture(): {
  gesture: ReturnType<typeof installTerminalLinkPointerGesture>
  element: HTMLDivElement
  setSelection: (selected: boolean) => void
} {
  let selected = false
  const element = document.createElement('div')
  document.body.appendChild(element)
  const terminal = {
    element,
    hasSelection: () => selected
  } as unknown as Terminal
  const gesture = installTerminalLinkPointerGesture(terminal)
  activeGestures.add(gesture)
  return {
    gesture,
    element,
    setSelection: (next) => {
      selected = next
    }
  }
}

function mouse(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y })
}

afterEach(() => {
  for (const gesture of activeGestures) {
    gesture.dispose()
  }
  activeGestures.clear()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('terminal link pointer gesture', () => {
  it('rejects a drag and a click that began with a selection', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const dragged = createGesture()
    const dragDown = mouse('mousedown', 10, 10)
    dragged.element.dispatchEvent(dragDown)
    document.dispatchEvent(mouse('mousemove', 20, 10))
    expect(dragged.gesture.canRequestAction(dragDown)).toBe(false)

    const selected = createGesture()
    selected.setSelection(true)
    const selectionDown = mouse('mousedown', 10, 10)
    selected.element.dispatchEvent(selectionDown)
    selected.setSelection(false)
    expect(selected.gesture.canRequestAction(selectionDown)).toBe(false)
  })

  it('rejects a selection created during the gesture and clears on blur', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const { element, gesture, setSelection } = createGesture()
    const down = mouse('mousedown', 10, 10)
    element.dispatchEvent(down)
    setSelection(true)
    expect(gesture.canRequestAction(down)).toBe(false)

    setSelection(false)
    window.dispatchEvent(new Event('blur'))
    expect(gesture.canRequestAction(down)).toBe(false)
  })

  it.each(['Macintosh', 'Windows', 'Linux'])(
    'protects floating clicks from drag and previous selection on %s',
    (userAgent) => {
      vi.stubGlobal('navigator', { userAgent })
      const { element, gesture, setSelection } = createGesture()
      const modifiers = userAgent === 'Macintosh' ? { metaKey: true } : { ctrlKey: true }
      const down = new MouseEvent('mousedown', {
        bubbles: true,
        button: 0,
        altKey: true,
        ...modifiers
      })
      element.dispatchEvent(down)
      expect(gesture.canRequestAction(down)).toBe(true)
      const up = new MouseEvent('mouseup', { button: 0, altKey: true, clientX: 10, ...modifiers })
      expect(gesture.canRequestAction(up)).toBe(false)
      setSelection(true)
      element.dispatchEvent(down)
      setSelection(false)
      expect(gesture.canRequestAction(down)).toBe(false)
    }
  )

  it('removes its listeners on dispose', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const { element, gesture } = createGesture()
    gesture.dispose()
    const down = mouse('mousedown', 10, 10)

    element.dispatchEvent(down)

    expect(gesture.canRequestAction(down)).toBe(false)
  })
})
