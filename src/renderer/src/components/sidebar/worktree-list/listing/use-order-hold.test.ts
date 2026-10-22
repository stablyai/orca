// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { SortBy } from '../../../../../../shared/sidebar-list/smart-sort'
import type { SidebarFeedIndex } from '../../../../../../shared/sidebar-list/sidebar-feed-index'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import { useOrderHeldWhileEngaged, useProjectRecencyHeldWhileEngaged } from './use-order-hold'

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

  it('holds through a press that leaves the list, and a mode switch applies at once', () => {
    const { row } = mountList()
    const outside = document.createElement('div')
    document.body.append(outside)
    const { result, rerender } = renderHook(
      ({ ids, sortBy }: { ids: string[]; sortBy: SortBy }) => useOrderHeldWhileEngaged(ids, sortBy),
      { initialProps: { ids: ['a', 'b'], sortBy: 'smart' } }
    )
    fire(row, 'pointerdown')
    fire(outside, 'pointerover')
    rerender({ ids: ['b', 'a'], sortBy: 'smart' })
    expect(result.current).toEqual(['a', 'b'])
    fire(outside, 'pointerup')
    expect(result.current).toEqual(['b', 'a'])

    fire(row, 'pointerover')
    rerender({ ids: ['a', 'b'], sortBy: 'name' })
    expect(result.current).toEqual(['a', 'b'])
  })

  it('holds through a drag in Smart and applies the order when the drag ends over the list', () => {
    const { row } = mountList()
    const { result, rerender } = renderHook(
      ({ ids, sortBy }: { ids: string[]; sortBy: SortBy }) => useOrderHeldWhileEngaged(ids, sortBy),
      { initialProps: { ids: ['a', 'b'], sortBy: 'smart' } }
    )
    fire(row, 'pointerover')
    fire(row, 'dragstart')
    rerender({ ids: ['b', 'a'], sortBy: 'smart' })
    expect(result.current).toEqual(['a', 'b'])
    fire(row, 'dragend')
    expect(result.current).toEqual(['b', 'a'])
  })

  it('never holds Manual or Name: your own drop or rename shows at once', () => {
    const { row } = mountList()
    const { result, rerender } = renderHook(
      ({ ids, sortBy }: { ids: string[]; sortBy: SortBy }) => useOrderHeldWhileEngaged(ids, sortBy),
      { initialProps: { ids: ['a', 'b'], sortBy: 'manual' } }
    )
    fire(row, 'pointerover')
    fire(row, 'dragstart')
    rerender({ ids: ['b', 'a'], sortBy: 'manual' })
    expect(result.current).toEqual(['b', 'a'])
    rerender({ ids: ['a', 'b'], sortBy: 'name' })
    expect(result.current).toEqual(['a', 'b'])
  })
})

describe('useProjectRecencyHeldWhileEngaged', () => {
  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
  })

  const indexAt = (recentAt: number): SidebarFeedIndex => ({
    workspaces: [],
    worktrees: [makeWorktree('b', 'b', { lastActivityAt: recentAt })],
    folderWorkspaces: [],
    repoMap: new Map(),
    repoOf: () => undefined
  })
  const recentOf = (index: SidebarFeedIndex): number[] =>
    index.worktrees.map((worktree: Worktree) => worktree.lastActivityAt)

  it('keeps Recent project stamps under the pointer, and lets go on leave or in Manual', () => {
    const { row } = mountList()
    const outside = document.createElement('div')
    document.body.append(outside)
    const { result, rerender } = renderHook(
      ({ index, by }: { index: SidebarFeedIndex; by: ProjectOrderBy }) =>
        useProjectRecencyHeldWhileEngaged(index, by),
      { initialProps: { index: indexAt(50), by: 'recent' } }
    )
    fire(row, 'pointerover')
    rerender({ index: indexAt(200), by: 'recent' })
    expect(recentOf(result.current)).toEqual([50])
    rerender({ index: indexAt(300), by: 'manual' })
    expect(recentOf(result.current)).toEqual([300])
    rerender({ index: indexAt(400), by: 'recent' })
    rerender({ index: indexAt(500), by: 'recent' })
    expect(recentOf(result.current)).toEqual([400])
    fire(outside, 'pointerover')
    expect(recentOf(result.current)).toEqual([500])
  })
})
