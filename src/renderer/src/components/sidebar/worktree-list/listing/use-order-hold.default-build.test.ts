// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { WorkspaceSortBy as SortBy } from '../../../../../../shared/workspace-view/workspace-row-sort'
import { useOrderHeldWhileEngaged } from './use-order-hold'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

function fire(target: EventTarget, type: string): void {
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true }))
  })
}

it('holds the bots order under the pointer in a shipped build, and releases it on leave or a mode switch', () => {
  const list = document.createElement('div')
  list.setAttribute('data-bot-sidebar-list', '')
  const outside = document.createElement('div')
  document.body.append(list, outside)
  const { result, rerender } = renderHook(
    ({ ids, sortBy }: { ids: string[]; sortBy: SortBy }) =>
      useOrderHeldWhileEngaged(ids, sortBy, 'bots'),
    { initialProps: { ids: ['a', 'b'], sortBy: 'smart' } }
  )
  fire(list, 'pointerover')
  rerender({ ids: ['b', 'a', 'new'], sortBy: 'smart' })
  expect(result.current).toEqual(['a', 'new', 'b'])
  fire(outside, 'pointerover')
  expect(result.current).toEqual(['b', 'a', 'new'])

  fire(list, 'pointerover')
  rerender({ ids: ['a', 'b', 'new'], sortBy: 'smart' })
  expect(result.current).toEqual(['b', 'a', 'new'])
  rerender({ ids: ['new', 'a', 'b'], sortBy: 'name' })
  expect(result.current).toEqual(['new', 'a', 'b'])
})
