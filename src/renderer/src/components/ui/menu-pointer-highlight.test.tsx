// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  MENU_POINTER_REST_MS,
  settleMenuHighlightAfterRest,
  syncMenuHighlightAtPoint,
  useMenuPointerHighlight
} from './menu-pointer-highlight'

let root: Root | null = null
let hit: Element | null = null
let frames: FrameRequestCallback[] = []

beforeEach(() => {
  hit = null
  frames = []
  document.elementFromPoint = vi.fn(() => hit)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => frames.push(cb))
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.useRealTimers()
})

type MenuProps = Pick<React.HTMLAttributes<HTMLDivElement>, 'onKeyDown' | 'onKeyDownCapture'>

function Menu(props: MenuProps): React.JSX.Element {
  const handlers = useMenuPointerHighlight(props)
  return (
    <div role="menu" data-state="open" tabIndex={-1} id="menu" {...handlers}>
      <div role="menuitem" tabIndex={-1} id="a">
        <span id="a-label">A</span>
      </div>
      <div role="menuitemcheckbox" tabIndex={-1} id="b" />
      <div role="menuitem" tabIndex={-1} id="c" data-disabled="" />
      <div role="separator" id="sep" />
    </div>
  )
}

function render(
  props: MenuProps = {}
): Record<'menu' | 'a' | 'aLabel' | 'b' | 'c' | 'sep', HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(<Menu {...props} />))
  const get = (id: string): HTMLElement => {
    const el = document.getElementById(id)
    if (!el) {
      throw new Error(`missing #${id}`)
    }
    return el
  }
  return {
    menu: get('menu'),
    a: get('a'),
    aLabel: get('a-label'),
    b: get('b'),
    c: get('c'),
    sep: get('sep')
  }
}

/** happy-dom's WheelEvent drops MouseEvent coordinates, which Chromium's WheelEvent carries. */
function wheelAt(menu: HTMLElement, clientX: number, clientY: number): void {
  const event = new WheelEvent('wheel', { bubbles: true })
  Object.defineProperties(event, { clientX: { value: clientX }, clientY: { value: clientY } })
  act(() => {
    menu.dispatchEvent(event)
  })
}

function scroll(menu: HTMLElement): void {
  act(() => {
    menu.dispatchEvent(new Event('scroll'))
    frames.splice(0).forEach((cb) => cb(0))
  })
}

it('moves the highlight to the row under the resting cursor on every wheel-scroll frame', () => {
  const { menu, a, aLabel, b } = render()
  a.focus()
  wheelAt(menu, 10, 40)
  hit = b
  scroll(menu)
  expect(document.activeElement).toBe(b)
  expect(document.elementFromPoint).toHaveBeenLastCalledWith(10, 40)

  hit = aLabel
  scroll(menu)
  expect(document.activeElement).toBe(a)
})

it('leaves keyboard-driven scrolling alone', () => {
  const { menu, a, b } = render()
  wheelAt(menu, 10, 40)
  a.focus()
  act(() => {
    a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })
  hit = b
  scroll(menu)
  expect(document.activeElement).toBe(a)
})

it.each([false, true])(
  'preserves keyboard focus when an input stops keydown propagation (queued frame: %s)',
  (queuedFrame) => {
    const { menu, a, b } = render()
    const input = document.createElement('input')
    menu.prepend(input)
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      a.focus()
    })
    input.focus()
    wheelAt(menu, 10, 40)
    hit = b
    if (queuedFrame) {
      act(() => menu.dispatchEvent(new Event('scroll')))
      expect(frames).toHaveLength(1)
    }
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    scroll(menu)
    expect(document.activeElement).toBe(a)

    wheelAt(menu, 10, 40)
    scroll(menu)
    expect(document.activeElement).toBe(b)
  }
)

it('preserves consumer capture and bubble keydown handlers', () => {
  const calls: string[] = []
  const { a } = render({
    onKeyDownCapture: (event) => calls.push(`capture:${event.key}`),
    onKeyDown: (event) => calls.push(`bubble:${event.key}`)
  })
  act(() => {
    a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })
  expect(calls).toEqual(['capture:ArrowDown', 'bubble:ArrowDown'])
})

it('does not let a queued wheel frame override subsequent keyboard navigation', () => {
  const { menu, a, b } = render()
  wheelAt(menu, 10, 40)
  hit = b
  act(() => menu.dispatchEvent(new Event('scroll')))
  expect(frames).toHaveLength(1)
  act(() => {
    a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    a.focus()
    frames.splice(0).forEach((cb) => cb(0))
  })
  expect(document.activeElement).toBe(a)

  wheelAt(menu, 10, 40)
  scroll(menu)
  expect(document.activeElement).toBe(b)
})

it.each(['input', 'textarea'])(
  'preserves a portaled setup %s while wheel and rest synchronization target another row',
  (tag) => {
    const { menu, a, b } = render()
    const input = document.createElement(tag)
    document.body.append(input)
    input.focus()
    hit = b
    wheelAt(menu, 10, 40)
    scroll(menu)
    expect(document.activeElement).toBe(input)

    openSubmenuOn(a)
    settleMenuHighlightAfterRest(menu, { x: 10, y: 40 })
    expect(document.activeElement).toBe(input)
  }
)

it('clears the highlight over disabled rows and separators, and skips closed menus or open submenus', () => {
  const { menu, a, b, c, sep } = render()
  a.focus()
  hit = c
  syncMenuHighlightAtPoint(menu, 0, 0)
  expect(document.activeElement).toBe(menu)

  a.focus()
  hit = sep
  syncMenuHighlightAtPoint(menu, 0, 0)
  expect(document.activeElement).toBe(menu)

  hit = b
  a.setAttribute('aria-haspopup', 'menu')
  a.setAttribute('data-state', 'open')
  syncMenuHighlightAtPoint(menu, 0, 0)
  expect(document.activeElement).toBe(menu)
  a.removeAttribute('data-state')

  menu.setAttribute('data-state', 'closed')
  syncMenuHighlightAtPoint(menu, 0, 0)
  expect(document.activeElement).toBe(menu)
})

it("ignores a cursor that is not over the menu, such as over a row's portaled popover", () => {
  const { menu, a } = render()
  const popover = document.createElement('div')
  document.body.append(popover)
  a.focus()
  hit = popover
  syncMenuHighlightAtPoint(menu, 0, 0)
  expect(document.activeElement).toBe(a)
})

it('does not pull focus out of a search field inside the menu', () => {
  const { menu, b } = render()
  const input = document.createElement('input')
  menu.prepend(input)
  input.focus()
  hit = b
  syncMenuHighlightAtPoint(menu, 0, 0)
  expect(document.activeElement).toBe(input)
})

/** Row `a` is a submenu trigger whose submenu is open, as after resting on it. */
function openSubmenuOn(a: HTMLElement): void {
  a.setAttribute('aria-haspopup', 'menu')
  a.setAttribute('data-state', 'open')
}

it('highlights the row a cursor rests on after a flick swallowed by the submenu safe triangle', () => {
  const { menu, a, b, c } = render()
  openSubmenuOn(a)
  a.focus()

  hit = b
  settleMenuHighlightAfterRest(menu, { x: 0, y: 0 })
  expect(document.activeElement).toBe(b)

  // Resting on the open trigger itself, or on a disabled row, keeps Radix in charge.
  a.focus()
  hit = a
  settleMenuHighlightAfterRest(menu, { x: 0, y: 0 })
  hit = c
  settleMenuHighlightAfterRest(menu, { x: 0, y: 0 })
  expect(document.activeElement).toBe(a)

  // Without an open submenu Radix already highlights on pointermove.
  a.removeAttribute('data-state')
  hit = b
  settleMenuHighlightAfterRest(menu, { x: 0, y: 0 })
  expect(document.activeElement).toBe(a)
})

function pointerMoveAt(target: HTMLElement, clientX: number, clientY: number): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX, clientY })
    )
  })
}

it('settles only once the cursor has stopped, and restarts the wait on every real move', () => {
  vi.useFakeTimers()
  const { menu, a, b } = render()
  openSubmenuOn(a)
  a.focus()
  hit = b

  pointerMoveAt(b, 10, 10)
  act(() => vi.advanceTimersByTime(MENU_POINTER_REST_MS - 20))
  pointerMoveAt(b, 10, 12)
  act(() => vi.advanceTimersByTime(MENU_POINTER_REST_MS - 20))
  expect(document.activeElement).toBe(a)

  act(() => vi.advanceTimersByTime(20))
  expect(document.activeElement).toBe(b)
  expect(document.elementFromPoint).toHaveBeenLastCalledWith(10, 12)

  // A keypress cancels a pending settle so it cannot override keyboard navigation.
  a.focus()
  pointerMoveAt(b, 10, 14)
  act(() => {
    a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  })
  act(() => vi.advanceTimersByTime(MENU_POINTER_REST_MS * 2))
  expect(document.activeElement).toBe(a)
  expect(menu.contains(document.activeElement)).toBe(true)
})

it.each(['button', 'div'])(
  'preserves focus on a non-editable setup %s when scrolling over its owning row',
  (tag) => {
    const { menu, a, b } = render()
    const trigger = document.createElement('button')
    trigger.setAttribute('data-slot', 'popover-trigger')
    trigger.setAttribute('aria-expanded', 'true')
    a.append(trigger)
    const control = document.createElement(tag)
    control.tabIndex = 0
    document.body.append(control)
    control.focus()
    hit = a
    wheelAt(menu, 10, 40)
    scroll(menu)
    expect(document.activeElement).toBe(control)

    openSubmenuOn(b)
    settleMenuHighlightAfterRest(menu, { x: 10, y: 40 })
    expect(document.activeElement).toBe(control)
  }
)

it('does not schedule pointer-rest timers without an open submenu', () => {
  vi.useFakeTimers()
  const { a, b } = render()
  pointerMoveAt(b, 10, 10)
  pointerMoveAt(b, 10, 12)
  expect(vi.getTimerCount()).toBe(0)

  openSubmenuOn(a)
  pointerMoveAt(b, 10, 14)
  expect(vi.getTimerCount()).toBe(1)
  a.setAttribute('data-state', 'closed')
  pointerMoveAt(b, 10, 16)
  expect(vi.getTimerCount()).toBe(0)
})
