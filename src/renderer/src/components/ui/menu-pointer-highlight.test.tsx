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

it('uses the current cursor position when it moves during wheel scrolling', () => {
  const { menu, a, b } = render()
  a.focus()
  wheelAt(menu, 10, 40)
  act(() => {
    b.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse',
        clientX: 20,
        clientY: 60
      })
    )
  })
  hit = b
  scroll(menu)
  expect(document.elementFromPoint).toHaveBeenLastCalledWith(20, 60)
  expect(document.activeElement).toBe(b)
})

it('preserves prevented pointer movement across further wheel events and queued frames', () => {
  const { menu, a, b } = render()
  a.focus()
  wheelAt(menu, 10, 40)
  act(() => menu.dispatchEvent(new Event('scroll')))
  const preventMove = (event: Event) => event.preventDefault()
  b.addEventListener('pointermove', preventMove)
  act(() => {
    b.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        pointerType: 'mouse',
        clientX: 20,
        clientY: 60
      })
    )
  })
  hit = b
  scroll(menu)
  expect(document.activeElement).toBe(a)

  wheelAt(menu, 20, 60)
  scroll(menu)
  act(() => {
    b.dispatchEvent(
      new PointerEvent('pointerover', {
        bubbles: true,
        pointerType: 'mouse',
        clientX: 20,
        clientY: 60
      })
    )
  })
  expect(document.activeElement).toBe(a)

  b.removeEventListener('pointermove', preventMove)
  act(() => {
    b.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        pointerType: 'mouse',
        clientX: 10,
        clientY: 60
      })
    )
  })
  wheelAt(menu, 10, 60)
  scroll(menu)
  expect(document.activeElement).toBe(b)
})

it('leaves moving-pointer boundary events to Radix after wheel scrolling', () => {
  const { menu, a, b } = render()
  a.focus()
  wheelAt(menu, 10, 40)
  hit = b
  act(() => {
    b.dispatchEvent(
      new PointerEvent('pointerover', {
        bubbles: true,
        pointerType: 'mouse',
        clientX: 20,
        clientY: 60
      })
    )
  })
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
  'resets wheel tracking when retained wrappers reopen their content (forceMount: %s)',
  async (forceMount) => {
    const { menu, a, b } = render({ forceMount })
    a.focus()
    wheelAt(menu, 10, 40)
    hit = b
    scroll(menu)
    expect(document.activeElement).toBe(b)
    act(() => menu.dispatchEvent(new Event('scroll')))
    await act(async () => root!.render(<Menu open={false} forceMount={forceMount} />))
    await act(async () => root!.render(<Menu forceMount={forceMount} />))

    const first = document.getElementById('a')!
    const next = document.getElementById('b')!
    const reopened = document.getElementById('menu')!
    first.focus()
    hit = next
    act(() => {
      next.dispatchEvent(
        new PointerEvent('pointerover', {
          bubbles: true,
          pointerType: 'mouse',
          clientX: 10,
          clientY: 40
        })
      )
    })
    scroll(reopened)
    expect(document.activeElement).toBe(first)

    wheelAt(reopened, 10, 40)
    scroll(reopened)
    expect(document.activeElement).toBe(next)
  }
)

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

it('clears the highlight over disabled rows and separators, follows scrolling past submenus, and skips closed menus', () => {
  const { menu, a, b, c, sep } = render()
  a.focus()
  hit = c
  wheelScroll(menu)
  expect(document.activeElement).toBe(menu)

  a.focus()
  hit = sep
  wheelScroll(menu)
  expect(document.activeElement).toBe(menu)

  hit = b
  a.setAttribute('aria-haspopup', 'menu')
  a.setAttribute('data-state', 'open')
  wheelScroll(menu)
  expect(document.activeElement).toBe(b)
  a.removeAttribute('data-state')

  menu.setAttribute('data-state', 'closed')
  wheelScroll(menu)
  expect(document.activeElement).toBe(b)
})

it("ignores a cursor that is not over the menu, such as over a row's portaled popover", () => {
  const { menu, a } = render()
  const popover = document.createElement('div')
  document.body.append(popover)
  a.focus()
  hit = popover
  wheelScroll(menu)
  expect(document.activeElement).toBe(a)
})

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
