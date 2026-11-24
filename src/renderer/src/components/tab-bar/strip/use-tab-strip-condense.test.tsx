// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useTabStripCondense } from './use-tab-strip-condense'

const IDS = ['a', 'b', 'c', 'd', 'e', 'f']
let width = 500
const resizeCallbacks: (() => void)[] = []

beforeEach(() => {
  width = 500
  resizeCallbacks.length = 0
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback)
      }
      observe(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Strip({
  renaming = false,
  ids = IDS,
  frozen = false
}: {
  renaming?: boolean
  ids?: readonly string[]
  frozen?: boolean
}): React.JSX.Element {
  const { plan, hiddenIds, setSurface } = useTabStripCondense({
    ids,
    activeId: 'c',
    frozen,
    hasOverflow: false
  })
  return (
    <div
      ref={(node) => {
        if (node) {
          Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => width })
        }
        setSurface(node)
      }}
      data-plan={plan.mode}
      data-hidden={[...hiddenIds].join(',')}
    >
      {renaming ? <input data-tab-rename-input="true" /> : null}
    </div>
  )
}

describe('useTabStripCondense', () => {
  it('re-plans a resize skipped during a rename once the rename ends, with no further resize', async () => {
    const { container, rerender } = render(<Strip renaming={false} />)
    const surface = container.firstElementChild!
    expect(surface.getAttribute('data-plan')).toBe('titled')

    rerender(<Strip renaming={true} />)
    width = 100
    act(() => resizeCallbacks.forEach((callback) => callback()))
    expect(surface.getAttribute('data-plan')).toBe('titled')

    rerender(<Strip renaming={false} />)
    await waitFor(() => expect(surface.getAttribute('data-plan')).toBe('condensed'))
  })

  it('hides a tab that replaces a hidden one while the plan is frozen', () => {
    width = 263
    const { container, rerender } = render(<Strip />)
    const surface = container.firstElementChild!
    expect(surface.getAttribute('data-hidden')).toBe('a,f')

    rerender(<Strip frozen ids={['a', 'b', 'c', 'd', 'e', 'g']} />)
    expect(surface.getAttribute('data-hidden')).toBe('a,g')
  })

  it('keeps held icon slots as icons across consecutive pointer closes', () => {
    // Slot geometry: the active tab is 132px, icon slots 32px, anything else 80px.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      const slotWidth =
        this.dataset.tabStripSlot === 'c' ? 132 : this.dataset.density === 'icon' ? 32 : 80
      return new DOMRect(0, 0, slotWidth, 0)
    })
    width = 479
    const { container, rerender } = render(<HeldStrip ids={IDS} />)
    const surface = container.firstElementChild!
    const iconSlots = (): string =>
      [...surface.querySelectorAll<HTMLElement>('[data-density="icon"]')]
        .map((slot) => slot.dataset.tabStripSlot)
        .join(',')
    expect(iconSlots()).toBe('a,b,d,e,f')

    fireEvent.pointerOver(surface)
    fireEvent.pointerDown(surface)
    rerender(<HeldStrip ids={['a', 'b', 'c', 'd', 'f']} />)
    expect(iconSlots()).toBe('a,b,d,f')

    fireEvent.pointerDown(surface)
    rerender(<HeldStrip ids={['a', 'b', 'c', 'd']} />)
    expect(iconSlots()).toBe('a,b,d')
  })
})

function HeldStrip({ ids }: { ids: readonly string[] }): React.JSX.Element {
  const { density, setSurface, stripPointerHandlers } = useTabStripCondense({
    ids,
    activeId: 'c',
    frozen: false,
    hasOverflow: false
  })
  return (
    <div
      ref={(node) => {
        if (node) {
          Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => width })
        }
        setSurface(node)
      }}
      {...stripPointerHandlers}
    >
      {ids.map((id) => (
        <div
          key={id}
          data-tab-strip-slot={id}
          data-density={density.iconIds.has(id) ? 'icon' : undefined}
        />
      ))}
    </div>
  )
}
