// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { useClearNameFilterForReveal } from './use-clear-name-filter-for-reveal'

const ROOT = '/repo'

function renderNameFilter(initialProps: { visibleFilesWorktreePath: string | null }) {
  return renderHook(
    ({ visibleFilesWorktreePath }) => {
      const [query, setQuery] = useState('')
      useClearNameFilterForReveal({
        activeWorktreeId: 'wt-1',
        visibleFilesWorktreePath,
        hasNameFilter: visibleFilesWorktreePath !== null && query.trim().length > 0,
        setNameFilterQuery: setQuery
      })
      return { query, setQuery }
    },
    { initialProps }
  )
}

function queueReveal(filePath: string): void {
  act(() => useAppStore.getState().revealInExplorer('wt-1', filePath))
}

describe('useClearNameFilterForReveal', () => {
  afterEach(() => {
    useAppStore.setState({ pendingExplorerReveal: null })
  })

  it('keeps a query typed while a reveal is pending and drops that reveal', () => {
    const { result } = renderNameFilter({ visibleFilesWorktreePath: ROOT })
    // A reveal under a hidden dotfile folder never resolves, so it stays pending.
    queueReveal('/repo/.github/workflows/ci.yml')

    act(() => result.current.setQuery('readme'))
    expect(result.current.query).toBe('readme')
    expect(useAppStore.getState().pendingExplorerReveal).toBeNull()
  })

  it('clears a kept query once for each reveal shown in the files tree', () => {
    const { result, rerender } = renderNameFilter({ visibleFilesWorktreePath: null })
    act(() => result.current.setQuery('readme'))

    queueReveal('/repo/src/a.ts')
    expect(result.current.query).toBe('readme')
    rerender({ visibleFilesWorktreePath: ROOT })
    expect(result.current.query).toBe('')
    expect(useAppStore.getState().pendingExplorerReveal?.filePath).toBe('/repo/src/a.ts')

    act(() => result.current.setQuery('alpha'))
    expect(result.current.query).toBe('alpha')
    queueReveal('/repo/src/b.ts')
    expect(result.current.query).toBe('')
  })
})
