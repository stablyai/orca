// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
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

function Strip({ renaming }: { renaming: boolean }): React.JSX.Element {
  const { plan, setSurface } = useTabStripCondense({
    ids: IDS,
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
      data-plan={plan.mode}
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
})
