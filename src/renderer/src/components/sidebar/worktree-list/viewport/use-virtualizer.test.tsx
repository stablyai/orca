// @vitest-environment happy-dom
import { act, useMemo } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import { buildLineageRowProjection } from '../listing/lineage-row-projection'
import { getRenderRowKey, type RenderRow } from '../listing/render-row'
import { repo, worktree } from '../grouping/worktree-list-groups-test-fixtures'
import { useWorktreeListVirtualizer } from './use-virtualizer'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

const rows: RenderRow[] = [
  { type: 'pending-creation', key: 'pending', creationId: 'pending', repo },
  {
    type: 'item',
    rowKey: 'a',
    sectionKey: 'all',
    repo,
    worktree: { ...worktree, id: 'a' },
    depth: 0,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: 0
  }
]

it('keeps a notice row slot stable across repeated remeasures', () => {
  const scroller = document.createElement('div')
  Object.defineProperty(scroller, 'clientHeight', { value: 600 })
  document.body.append(scroller)
  const notice = document.createElement('div')
  notice.setAttribute('data-index', '0')
  notice.setAttribute('data-worktree-virtual-row-key', getRenderRowKey(rows[0]))
  Object.defineProperty(notice, 'offsetHeight', { value: 32 })
  scroller.append(notice)

  const { result } = renderHook(() => {
    const projection = useMemo(() => buildLineageRowProjection(rows, 'none', false), [])
    const marks = useMemo(() => createProgrammaticScrollMarks(), [])
    return useWorktreeListVirtualizer({
      projection,
      renderRows: rows,
      firstHeaderIndex: -1,
      scrollRef: { current: scroller },
      scrollOffsetRef: { current: 0 },
      programmaticScrollMarks: marks
    })
  })
  const { virtualizer } = result.current
  act(() => virtualizer.measureElement(notice))
  const settledTotal = virtualizer.getTotalSize()
  for (let i = 0; i < 5; i++) {
    act(() => virtualizer.measureElement(notice))
  }

  expect(virtualizer.getTotalSize()).toBe(settledTotal)
  expect(virtualizer.measurementsCache[0].size).toBe(38)
})
