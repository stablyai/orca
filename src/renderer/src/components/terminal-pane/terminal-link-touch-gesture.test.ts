// @vitest-environment happy-dom
import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTerminalLinkTouchGesture } from './terminal-link-touch-gesture'

const disposables: { dispose: () => void }[] = []
/**
 * Builds a happy-dom terminal stub with the gesture installed and touch event helpers.
 *
 * Returns the spied `activate` plus senders so each test drives raw touch sequences.
 */
function fixture() {
  const element = document.createElement('div')
  element.innerHTML = '<div class="xterm-screen"></div><button>Header</button>'
  document.body.append(element)
  let selection = false
  const buffer = { viewportY: 0 }
  const activate = vi.fn(() => true)
  const disposable = installTerminalLinkTouchGesture(
    {
      element,
      hasSelection: () => selection,
      buffer: { active: buffer }
    } as unknown as Terminal,
    activate
  )
  disposables.push(disposable)
  const touch = (x = 20, y = 30, identifier = 1) => ({ clientX: x, clientY: y, identifier })
  const send = (
    type: string,
    touches: ReturnType<typeof touch>[],
    changedTouches = touches,
    target = element.firstElementChild!
  ) => {
    const event = new Event(type, { bubbles: true, cancelable: true })
    Object.assign(event, { touches, changedTouches })
    target.dispatchEvent(event)
    return event
  }
  return {
    activate,
    send,
    touch,
    element,
    buffer,
    disposable,
    setSelection: (value: boolean) => {
      selection = value
    }
  }
}
afterEach(() => {
  for (const disposable of disposables.splice(0)) {
    disposable.dispose()
  }
  document.body.replaceChildren()
  vi.useRealTimers()
})

describe('terminal link touch gesture', () => {
  it('activates once at the original cell despite small finger jitter', () => {
    const f = fixture()
    f.send('touchstart', [f.touch()])
    f.send('touchmove', [f.touch(23, 32)])
    expect(f.send('touchend', [], [f.touch(23, 32)]).defaultPrevented).toBe(true)
    f.send('touchend', [], [f.touch()])
    expect(f.activate).toHaveBeenCalledExactlyOnceWith({ x: 20, y: 30 })
  })
  it('does not cancel a tap when no link is handled', () => {
    const f = fixture()
    f.activate.mockReturnValue(false)
    f.send('touchstart', [f.touch()])
    expect(f.send('touchend', [], [f.touch()]).defaultPrevented).toBe(false)
  })
  it.each([
    'scroll',
    'return-drag',
    'long-press',
    'pinch',
    'cancel',
    'selection',
    'existing-selection',
    'buffer-scroll',
    'blur',
    'dispose'
  ])('rejects %s', (kind) => {
    vi.useFakeTimers()
    const f = fixture()
    if (kind === 'existing-selection') {
      f.setSelection(true)
    }
    f.send('touchstart', [f.touch()])
    if (kind === 'scroll' || kind === 'return-drag') {
      f.send('touchmove', [f.touch(20, 60)])
    }
    if (kind === 'return-drag') {
      f.send('touchmove', [f.touch()])
    }
    if (kind === 'long-press') {
      vi.advanceTimersByTime(550)
    }
    if (kind === 'pinch') {
      f.send('touchstart', [f.touch(), f.touch(80, 80, 2)])
    }
    if (kind === 'cancel') {
      f.send('touchcancel', [])
    }
    if (kind === 'selection') {
      f.setSelection(true)
    }
    if (kind === 'existing-selection') {
      f.setSelection(false)
    }
    if (kind === 'buffer-scroll') {
      f.buffer.viewportY = 1
    }
    if (kind === 'blur') {
      window.dispatchEvent(new Event('blur'))
    }
    if (kind === 'dispose') {
      f.disposable.dispose()
    }
    f.send('touchend', [], [f.touch()])
    expect(f.activate).not.toHaveBeenCalled()
  })
  it('ignores header controls and mouse clicks', () => {
    const f = fixture()
    f.send('touchstart', [f.touch()], undefined, f.element.lastElementChild!)
    f.send('touchend', [], [f.touch()], f.element.lastElementChild!)
    f.element.firstElementChild!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(f.activate).not.toHaveBeenCalled()
  })
})
