// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useOrderHeldWhileEngaged } from './use-order-hold'

vi.mock('../../../../../../shared/sidebar-list/feed/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: true
}))

function mountList(attribute = 'data-worktree-sidebar-container') {
  const list = document.createElement('div')
  list.setAttribute(attribute, '')
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

  it('holds only the list under the pointer, so the bots and project lists never freeze each other', () => {
    const { row: projectRow } = mountList()
    const { row: botRow } = mountList('data-bot-sidebar-list')
    const projects = renderHook(
      ({ ids }: { ids: string[] }) => useOrderHeldWhileEngaged(ids, 'smart'),
      {
        initialProps: { ids: ['a', 'b'] }
      }
    )
    const bots = renderHook(
      ({ ids }: { ids: string[] }) => useOrderHeldWhileEngaged(ids, 'smart', 'bots'),
      { initialProps: { ids: ['x', 'y'] } }
    )

    fire(botRow, 'pointerover')
    projects.rerender({ ids: ['b', 'a'] })
    bots.rerender({ ids: ['y', 'x'] })
    expect(projects.result.current).toEqual(['b', 'a'])
    expect(bots.result.current).toEqual(['x', 'y'])

    fire(projectRow, 'pointerover')
    projects.rerender({ ids: ['a', 'b'] })
    expect(projects.result.current).toEqual(['b', 'a'])
    expect(bots.result.current).toEqual(['y', 'x'])
  })

  it('settles when each render passes a fresh array of a new order', () => {
    const { result, rerender } = renderHook(
      ({ order }: { order: string }) =>
        useOrderHeldWhileEngaged(order.split(','), 'recent', 'bots'),
      { initialProps: { order: 'a,b' } }
    )
    rerender({ order: 'b,a' })
    expect(result.current).toEqual(['b', 'a'])
  })
})
