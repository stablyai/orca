// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useArtifactListSelection } from './use-artifact-list-selection'

const VISIBLE = ['a', 'b', 'c', 'd', 'e'] as const

function renderSelection() {
  return renderHook(() => useArtifactListSelection(VISIBLE))
}

const checked = (result: { current: { checkedSlugs: ReadonlySet<string> } }): string[] =>
  [...result.current.checkedSlugs].sort()

afterEach(() => cleanup())

describe('useArtifactListSelection shift-range', () => {
  it('checks every visible row between the anchor and the shift-clicked row, in either direction', () => {
    const { result } = renderSelection()
    act(() => result.current.toggle('b', false))
    act(() => result.current.toggle('d', true))
    expect(checked(result)).toEqual(['b', 'c', 'd'])

    act(() => result.current.toggle('a', true))
    expect(checked(result)).toEqual(['a', 'b', 'c', 'd'])
    expect(result.current.headerState).toBe('indeterminate')
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
