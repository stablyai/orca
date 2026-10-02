// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerMouseShortcutDispatch } from './mouse-shortcut-dispatch'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

function setup(
  consume = true,
  bound = true
): {
  listener: ReturnType<typeof vi.fn>
  target: HTMLButtonElement
} {
  const target = document.createElement('button')
  document.body.appendChild(target)
  target.focus()
  const listener = vi.fn((event: KeyboardEvent) => {
    if (consume) {
      event.preventDefault()
    }
  })
  target.addEventListener('keydown', listener)
  cleanups.push(registerMouseShortcutDispatch(() => bound))
  return { listener, target }
}

function mouse(type: string, button: number, modifiers: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(type, { button, bubbles: true, cancelable: true, ...modifiers })
  document.body.dispatchEvent(event)
  return event
}

describe('mouse shortcut dispatch', () => {
  it.each([
    [3, 'MouseBack'],
    [4, 'MouseForward']
  ] as const)('routes button %s once to the focused handler', (button, key) => {
    const { listener } = setup()
    expect(mouse('mousedown', button, { ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(
      true
    )
    expect(listener).toHaveBeenCalledOnce()
    expect(listener.mock.calls[0][0]).toMatchObject({
      key,
      code: key,
      ctrlKey: true,
      shiftKey: true
    })
    expect(mouse('mouseup', button).defaultPrevented).toBe(true)
    expect(mouse('auxclick', button).defaultPrevented).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    expect(mouse('auxclick', button).defaultPrevented).toBe(false)
  })

  it('leaves unbound buttons and regular clicks alone', () => {
    const { listener } = setup(true, false)
    for (const button of [0, 1, 2, 3, 4]) {
      expect(mouse('mousedown', button).defaultPrevented).toBe(false)
      expect(mouse('mouseup', button).defaultPrevented).toBe(false)
    }
    expect(listener).not.toHaveBeenCalled()
  })

  it('keeps a handled press owned until release even if a duplicate changes modifiers', () => {
    const { listener } = setup()
    expect(mouse('mousedown', 3).defaultPrevented).toBe(true)
    expect(mouse('mousedown', 3, { shiftKey: true }).defaultPrevented).toBe(true)
    expect(listener).toHaveBeenCalledOnce()
    expect(mouse('mouseup', 3, { shiftKey: true }).defaultPrevented).toBe(true)
    expect(mouse('auxclick', 3, { shiftKey: true }).defaultPrevented).toBe(true)
    expect(mouse('mousedown', 3).defaultPrevented).toBe(true)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('preserves default navigation when no handler consumes a bound gesture', () => {
    const { listener } = setup(false)
    expect(mouse('mousedown', 3).defaultPrevented).toBe(false)
    expect(mouse('mouseup', 3).defaultPrevented).toBe(false)
    expect(listener).toHaveBeenCalledOnce()
  })

  it('captures unassigned buttons while the recorder is focused', () => {
    const { listener, target } = setup(true, false)
    target.setAttribute('data-shortcut-recorder-active', '')
    expect(mouse('mousedown', 4, { altKey: true }).defaultPrevented).toBe(true)
    expect(listener.mock.calls[0][0]).toMatchObject({ key: 'MouseForward', altKey: true })
  })

  it('clears consumed gestures on blur and removes listeners on cleanup', () => {
    setup()
    mouse('mousedown', 3)
    window.dispatchEvent(new Event('blur'))
    expect(mouse('mouseup', 3).defaultPrevented).toBe(false)
    cleanups.splice(0).forEach((cleanup) => cleanup())
    expect(mouse('mousedown', 3).defaultPrevented).toBe(false)
  })
})

describe('native mouse shortcut fallback', () => {
  it('forwards unhandled shortcuts once and consumes their release', () => {
    const native = vi.fn(() => true)
    cleanups.push(registerMouseShortcutDispatch(() => true, native))
    expect(mouse('mousedown', 3).defaultPrevented).toBe(true)
    expect(mouse('mouseup', 3).defaultPrevented).toBe(true)
    expect(native).toHaveBeenCalledOnce()
  })

  it.each([false, true])(
    'does not forward renderer-handled input while recording %s',
    (recording) => {
      const target = document.createElement('button')
      document.body.appendChild(target)
      target.focus()
      if (recording) {
        target.setAttribute('data-shortcut-recorder-active', '')
      } else {
        target.addEventListener('keydown', (event) => event.preventDefault())
      }
      const native = vi.fn(() => true)
      cleanups.push(registerMouseShortcutDispatch(() => true, native))
      mouse('mousedown', 4)
      expect(native).not.toHaveBeenCalled()
    }
  )
})

it('releases held shortcuts once on mouseup, including after the focused surface disappears', () => {
  const { target } = setup()
  const release = vi.fn()
  window.addEventListener('keyup', release)
  cleanups.push(() => window.removeEventListener('keyup', release))
  mouse('mousedown', 3, { shiftKey: true })
  target.remove()
  mouse('mouseup', 3)
  mouse('auxclick', 3)
  expect(release).toHaveBeenCalledOnce()
  expect(release.mock.calls[0][0]).toMatchObject({
    key: 'MouseBack',
    code: 'MouseBack',
    shiftKey: false
  })
})
