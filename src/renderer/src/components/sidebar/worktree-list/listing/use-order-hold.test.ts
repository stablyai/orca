// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import { useOrderHeldWhileEngaged } from './use-order-hold'

vi.mock('../../../../../../shared/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: true
}))

function mountList() {
  const list = document.createElement('div')
  list.setAttribute('data-worktree-sidebar-container', '')
  const row = document.createElement('div')
  list.append(row)
  document.body.append(list)
  return { list, row }
}

function fire(target: EventTarget, type: string, init: PointerEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, ...init }))
  })
}

describe('useOrderHeldWhileEngaged', () => {
  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
  })

  it('holds the order under the pointer and applies it when the pointer leaves', () => {
    const { row } = mountList()
    const outside = document.createElement('div')
    document.body.append(outside)
    const { result, rerender } = renderHook(
      ({ ids, sortBy }: { ids: string[]; sortBy: SortBy }) => useOrderHeldWhileEngaged(ids, sortBy),
      { initialProps: { ids: ['a', 'b'], sortBy: 'recent' } }
    )
    fire(row, 'pointerover')
    rerender({ ids: ['b', 'a', 'new'], sortBy: 'recent' })
    // Rows keep their places; a new row shows at once, after the row the new order puts before it.
    expect(result.current).toEqual(['a', 'new', 'b'])
    fire(outside, 'pointerover')
    expect(result.current).toEqual(['b', 'a', 'new'])
  })
})
