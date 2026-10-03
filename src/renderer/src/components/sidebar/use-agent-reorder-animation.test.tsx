// @vitest-environment happy-dom
import { StrictMode } from 'react'
import { render, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAgentReorderAnimation } from './use-agent-reorder-animation'

function List({ order }: { order: string[] }) {
  const ref = useAgentReorderAnimation(order)
  return (
    <div ref={ref}>
      {order.map((key, index) => (
        <div key={key} data-agent-reorder-key={key} data-top={index * 24}>
          {key}
        </div>
      ))}
    </div>
  )
}

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalAnimate) {
    Object.defineProperty(HTMLElement.prototype, 'animate', originalAnimate)
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'animate')
  }
})

function setup(reduced = false) {
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    matches: reduced,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  })
  const observers: { callback: () => void; connected: boolean }[] = []
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      entry: { callback: () => void; connected: boolean }
      constructor(callback: () => void) {
        this.entry = { callback, connected: true }
        observers.push(this.entry)
      }
      observe() {}
      disconnect() {
        disconnect()
        this.entry.connected = false
      }
    }
  )
  const resize = () =>
    observers.filter((observer) => observer.connected).forEach((observer) => observer.callback())
  const offsets = new Map<HTMLElement, number>()
  const measure = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      let offset = offsets.get(this) ?? 0
      for (let node: HTMLElement | null = this.parentElement; node; node = node.parentElement) {
        offset += offsets.get(node) ?? 0
      }
      return new DOMRect(0, Number(this.dataset.top ?? 0) + offset, 100, 24)
    })
  const cancel = vi.fn()
  const animate = vi.fn(function (
    this: HTMLElement,
    _frames: Keyframe[],
    _options: KeyframeAnimationOptions
  ) {
    return {
      cancel: () => {
        cancel()
        offsets.delete(this)
      },
      playState: 'running'
    }
  })
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  return { cancel, animate, offsets, measure, resize, disconnect, observers }
}

describe('agent reorder motion', () => {
  it('moves both rows vertically only after a reorder and cleans up on unmount', () => {
    const { animate, cancel } = setup()
    const view = render(<List order={['a', 'b']} />)
    expect(animate).not.toHaveBeenCalled()
    view.rerender(<List order={['b', 'a']} />)
    expect(animate).toHaveBeenNthCalledWith(
      1,
      [{ translate: '0 24px' }, { translate: '0 0' }],
      expect.objectContaining({ duration: 180 })
    )
    expect(animate).toHaveBeenNthCalledWith(
      2,
      [{ translate: '0 -24px' }, { translate: '0 0' }],
      expect.anything()
    )
    view.rerender(<List order={['b', 'a']} />)
    expect(cancel).not.toHaveBeenCalled()
    view.rerender(<List order={['a', 'b']} />)
    expect(cancel).toHaveBeenCalledTimes(2)
    view.unmount()
    expect(cancel).toHaveBeenCalledTimes(4)
  })

  it('respects reduced motion and does not animate initial, added or removed rows', () => {
    const { animate, measure } = setup(true)
    const view = render(<List order={['a', 'b']} />)
    view.rerender(<List order={['b', 'a']} />)
    expect(animate).not.toHaveBeenCalled()
    expect(measure).not.toHaveBeenCalled()
    view.unmount()
    setup()
    const next = render(<List order={['a']} />)
    next.rerender(<List order={['b', 'a']} />)
    next.rerender(<List order={['b']} />)
    expect(HTMLElement.prototype.animate).not.toHaveBeenCalled()
  })
})

function NestedList({ reversed }: { reversed: boolean }) {
  const order = reversed ? ['q', 'c', 'p', 'b', 'a'] : ['p', 'a', 'b', 'q', 'c']
  const ref = useAgentReorderAnimation(order)
  const branches = reversed ? ['q', 'p'] : ['p', 'q']
  return (
    <div ref={ref}>
      {branches.map((key) => {
        const top = key === 'p' ? (reversed ? 48 : 0) : reversed ? 0 : 72
        const children = key === 'q' ? ['c'] : reversed ? ['b', 'a'] : ['a', 'b']
        return (
          <div key={key} data-agent-reorder-key={key} data-top={top}>
            {children.map((child, index) => (
              <div key={child} data-agent-reorder-key={child} data-top={top + 24 * (index + 1)}>
                {child}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

it('animates child siblings relative to their parent without duplicating parent motion', () => {
  const { animate } = setup()
  const view = render(<NestedList reversed={false} />)
  view.rerender(<NestedList reversed />)
  expect(animate.mock.calls.map((call) => call[0])).toEqual([
    [{ translate: '0 72px' }, { translate: '0 0' }],
    [{ translate: '0 -48px' }, { translate: '0 0' }],
    [{ translate: '0 24px' }, { translate: '0 0' }],
    [{ translate: '0 -24px' }, { translate: '0 0' }]
  ])
})

it('does not measure or animate inert collapsed rows', () => {
  const { animate, measure } = setup()
  const view = render(
    <div inert>
      <List order={['a', 'b']} />
    </div>
  )
  view.rerender(
    <div inert>
      <List order={['b', 'a']} />
    </div>
  )
  expect(animate).not.toHaveBeenCalled()
  expect(measure).not.toHaveBeenCalled()
})

function PartlyHiddenList({ reversed }: { reversed: boolean }) {
  const ref = useAgentReorderAnimation(reversed ? ['b', 'a', 'hidden'] : ['a', 'hidden', 'b'])
  return (
    <div ref={ref}>
      {(reversed ? ['b', 'a'] : ['a', 'b']).map((key, index) => (
        <div key={key} data-agent-reorder-key={key} data-top={24 * index}>
          {key}
        </div>
      ))}
    </div>
  )
}

it('animates visible rows while a lineage descendant is unmounted', () => {
  const { animate } = setup()
  const view = render(<PartlyHiddenList reversed={false} />)
  view.rerender(<PartlyHiddenList reversed />)
  expect(animate).toHaveBeenCalledTimes(2)
})

function VariableHeightList({ reversed, height }: { reversed: boolean; height: number }) {
  const order = reversed ? ['b', 'a'] : ['a', 'b']
  const ref = useAgentReorderAnimation(order)
  return (
    <div ref={ref}>
      {order.map((key, index) => (
        <div key={key} data-agent-reorder-key={key} data-top={index * height}>
          {key}
        </div>
      ))}
    </div>
  )
}

it('refreshes layout snapshots after rows change height without changing order', () => {
  const { animate, resize } = setup()
  const view = render(<VariableHeightList reversed={false} height={24} />)
  view.rerender(<VariableHeightList reversed={false} height={48} />)
  resize()
  view.rerender(<VariableHeightList reversed height={48} />)
  expect(animate).toHaveBeenNthCalledWith(
    1,
    [{ translate: '0 48px' }, { translate: '0 0' }],
    expect.anything()
  )
})

function LazyList({ expanded, reversed }: { expanded: boolean; reversed: boolean }) {
  const order = reversed ? ['b', 'a'] : ['a', 'b']
  const ref = useAgentReorderAnimation(order)
  return (
    <div ref={ref}>
      {expanded &&
        order.map((key, index) => (
          <div key={key} data-agent-reorder-key={key} data-top={24 * index}>
            {key}
          </div>
        ))}
    </div>
  )
}

it('measures newly expanded compact rows before their first reorder', () => {
  const { animate } = setup()
  const view = render(<LazyList expanded={false} reversed={false} />)
  view.rerender(<LazyList expanded reversed={false} />)
  expect(animate).not.toHaveBeenCalled()
  view.rerender(<LazyList expanded reversed />)
  expect(animate).toHaveBeenCalledTimes(2)
})

it('continues interrupted motion from the position visible before the second commit', () => {
  const { animate, offsets } = setup()
  const view = render(<List order={['a', 'b', 'c']} />)
  view.rerender(<List order={['b', 'a', 'c']} />)
  const a = view.container.querySelector<HTMLElement>('[data-agent-reorder-key="a"]')!
  const b = view.container.querySelector<HTMLElement>('[data-agent-reorder-key="b"]')!
  offsets.set(a, -12)
  offsets.set(b, 12)
  const visibleBefore = a.getBoundingClientRect().top
  expect(visibleBefore).toBe(12)
  animate.mockClear()
  view.rerender(<List order={['b', 'c', 'a']} />)
  // The new DOM layout is 48; continuing from 12 requires a -36 translation.
  expect(animate.mock.calls.map((call) => call[0])).toEqual([
    [{ translate: '0 12px' }, { translate: '0 0' }],
    [{ translate: '0 24px' }, { translate: '0 0' }],
    [{ translate: '0 -36px' }, { translate: '0 0' }]
  ])
})

it('skips geometry reads on status-only renders and disconnects its size observer', () => {
  const { measure, disconnect } = setup()
  const view = render(<List order={['a', 'b']} />)
  measure.mockClear()
  view.rerender(<List order={['a', 'b']} />)
  view.rerender(<List order={['a', 'b']} />)
  expect(measure).not.toHaveBeenCalled()
  view.unmount()
  expect(disconnect).toHaveBeenCalledOnce()
})

it('reconnects size observation after StrictMode effect replay and tracks changed heights', () => {
  const { animate, resize, observers } = setup()
  const view = render(
    <StrictMode>
      <VariableHeightList reversed={false} height={24} />
    </StrictMode>
  )
  expect(observers.filter((observer) => observer.connected)).toHaveLength(1)
  view.rerender(
    <StrictMode>
      <VariableHeightList reversed={false} height={48} />
    </StrictMode>
  )
  resize()
  view.rerender(
    <StrictMode>
      <VariableHeightList reversed height={48} />
    </StrictMode>
  )
  expect(animate).toHaveBeenNthCalledWith(
    1,
    [{ translate: '0 48px' }, { translate: '0 0' }],
    expect.anything()
  )
  view.unmount()
  expect(observers.filter((observer) => observer.connected)).toHaveLength(0)
})

it('preserves in-flight motion on status updates without ResizeObserver', () => {
  const { animate, cancel, measure } = setup()
  vi.stubGlobal('ResizeObserver', undefined)
  const view = render(<List order={['a', 'b']} />)
  view.rerender(<List order={['b', 'a']} />)
  measure.mockClear()
  view.rerender(<List order={['b', 'a']} />)
  expect(cancel).not.toHaveBeenCalled()
  expect(measure).not.toHaveBeenCalled()
  expect(animate).toHaveBeenCalledTimes(2)
})
