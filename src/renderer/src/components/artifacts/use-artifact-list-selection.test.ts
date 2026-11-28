// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useArtifactListSelection } from './use-artifact-list-selection'

const ALL = ['a', 'b', 'c', 'd', 'e'] as const

function renderSelection(visible: readonly string[] = ALL) {
  return renderHook(({ slugs }) => useArtifactListSelection(slugs), {
    initialProps: { slugs: visible }
  })
}

const checked = (result: { current: { checkedSlugs: ReadonlySet<string> } }): string[] =>
  [...result.current.checkedSlugs].sort()

afterEach(() => cleanup())

describe('useArtifactListSelection shift-range', () => {
  it('checks every visible row from the anchor down to the shift-clicked row', () => {
    const { result } = renderSelection()
    act(() => result.current.toggle('b', false))
    act(() => result.current.toggle('d', true))
    expect(checked(result)).toEqual(['b', 'c', 'd'])
    expect(result.current.headerState).toBe('indeterminate')
  })

  it('checks upward from the anchor across rows that were all unchecked', () => {
    const { result } = renderSelection()
    act(() => result.current.toggle('d', false))
    act(() => result.current.toggle('b', true))
    expect(checked(result)).toEqual(['b', 'c', 'd'])
  })

  it('unchecks the range when the shift-clicked row was already checked', () => {
    const { result } = renderSelection()
    act(() => result.current.toggleAllVisible())
    act(() => result.current.toggle('b', false))
    act(() => result.current.toggle('d', true))
    expect(checked(result)).toEqual(['a', 'e'])
  })

  it('checks only the clicked row when there is no anchor yet', () => {
    const { result } = renderSelection()
    act(() => result.current.toggle('c', true))
    expect(checked(result)).toEqual(['c'])
  })
})

describe('useArtifactListSelection announcement', () => {
  it('reads the user’s checks, not the rows a delete batch removes, when the selection changes mid-batch', () => {
    const { result, rerender } = renderSelection()
    act(() => result.current.toggle('a', false))
    act(() => result.current.toggle('c', true))
    expect(result.current.announcement.count).toBe(3)
    const batchStart = result.current.announcement

    // The batch deletes a; pruning it must not re-announce.
    rerender({ slugs: ['b', 'c', 'd', 'e'] })
    expect(checked(result)).toEqual(['b', 'c'])
    expect(result.current.announcement).toEqual(batchStart)

    // Checking d mid-batch announces the current count, matching the selection bar.
    act(() => result.current.toggle('d', false))
    expect(result.current.announcement.count).toBe(3)
    expect(result.current.announcement.seq).not.toBe(batchStart.seq)

    // The batch deletes b and c; still no announcement from the prune.
    const afterCheck = result.current.announcement
    rerender({ slugs: ['d', 'e'] })
    expect(checked(result)).toEqual(['d'])
    expect(result.current.announcement).toEqual(afterCheck)

    // Clearing mid-batch empties the region silently.
    act(() => result.current.clear())
    expect(result.current.announcement.count).toBe(0)
  })

  it('empties silently when a batch removes every checked row, so the next check still reads', () => {
    const { result, rerender } = renderSelection()
    act(() => result.current.toggle('a', false))
    rerender({ slugs: ['b', 'c'] })
    expect(result.current.announcement.count).toBe(0)
    act(() => result.current.toggle('b', false))
    expect(result.current.announcement.count).toBe(1)
  })
})
