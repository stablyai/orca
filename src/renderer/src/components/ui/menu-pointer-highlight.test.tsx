// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMenuPointerHighlight } from './menu-pointer-highlight'

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
})

type MenuProps = Pick<React.HTMLAttributes<HTMLDivElement>, 'onKeyDown' | 'onKeyDownCapture'> & {
  open?: boolean
  forceMount?: boolean
}

function Menu({ open = true, forceMount = false, ...props }: MenuProps): React.JSX.Element | null {
  const handlers = useMenuPointerHighlight(props)
  if (!open && !forceMount) {
    return null
  }
  return (
    <div
      role="menu"
      data-state={open ? 'open' : 'closed'}
      tabIndex={-1}
      id="menu"
      {...props}
      {...handlers}
    >
      <div role="menuitem" tabIndex={-1} id="a">
        <span id="a-label">A</span>
      </div>
      <div role="menuitemcheckbox" aria-checked="false" tabIndex={-1} id="b" />
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

function wheelScroll(menu: HTMLElement): void {
  wheelAt(menu, 0, 0)
  scroll(menu)
}

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
  'preserves a portaled setup %s while wheel synchronization targets another row',
  (tag) => {
    const { menu, b } = render()
    const input = document.createElement(tag)
    document.body.append(input)
    input.focus()
    hit = b
    wheelAt(menu, 10, 40)
    scroll(menu)
    expect(document.activeElement).toBe(input)
  }
)

it('does not pull focus out of a search field inside the menu', () => {
  const { menu, b } = render()
  const input = document.createElement('input')
  menu.prepend(input)
  input.focus()
  hit = b
  wheelScroll(menu)
  expect(document.activeElement).toBe(input)
})

it.each(['button', 'div'])(
  'preserves focus on a non-editable setup %s when scrolling over its owning row',
  (tag) => {
    const { menu, a } = render()
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
  }
)
