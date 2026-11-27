// @vitest-environment happy-dom
import { act, render, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import {
  advanceFakeClock,
  field,
  FieldHost,
  mounted,
  pending,
  resultFor
} from './combined-search-test-harness'
import { getInitialSearchDraft } from './use-search-draft-lifecycle'
import { useCombinedSearch } from './useCombinedSearch'

const noop = (): void => {}

/** The search field as the Files pane mounts it: keyed per worktree, opening on its initial draft. */
function renderField(worktreeId: string) {
  return renderHook(() => {
    const [start] = useState(() => getInitialSearchDraft(worktreeId))
    const [query, setQuery] = useState(start.text)
    return useCombinedSearch({
      activeWorktreeId: worktreeId,
      worktreePath: '/repo',
      query,
      setQuery,
      nameMatches: query.trim() ? { total: 0, matches: [] } : null,
      namesLoading: false,
      namesError: null,
      onOpenName: noop,
      onShowAllNames: noop,
      initial: start
    })
  })
}

type Field = ReturnType<typeof renderField>['result']

function textRowKeys(result: Field): string[] {
  const { model } = result.current.results
  return Array.from({ length: model.count }, (_, index) => model.getKey(index)).filter(
    (key) => key.startsWith('file:') || key.startsWith('match:')
  )
}

describe('combined search text state', () => {
  it('scans a one-character query seeded on a cold open exactly once', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-seed' })
    useAppStore.getState().showRightSidebarSearch({ query: 'x' })
    const { result } = renderField('wt-seed')
    expect(result.current.field.query).toBe('x')
    await advanceFakeClock(1000)
    expect(pending.map((request) => request.query)).toEqual(['x'])
    await act(async () => pending[0].resolve(resultFor('x')))
    expect(textRowKeys(result)).toEqual(['file:/repo/x.ts', 'match:/repo/x.ts:1:1:0'])
  })

  it('never keeps the previous query rows while the next scan runs', async () => {
    const { result } = renderField('wt-stale')
    act(() => result.current.field.onQueryChange('cart'))
    await advanceFakeClock()
    await act(async () => pending[0].resolve(resultFor('cart')))
    expect(textRowKeys(result)).toHaveLength(2)

    act(() => result.current.field.onQueryChange('cars'))
    expect(textRowKeys(result)).toEqual([])
    await advanceFakeClock()
    expect(pending.map((request) => request.query)).toEqual(['cart', 'cars'])
    expect(textRowKeys(result)).toEqual([])
    expect(result.current.field.loading).toBe(true)
  })

  it('reopens on the newest draft when the field is swapped in one update', async () => {
    // FileExplorer keys the pane by route owner, so an owner change replaces the field in one commit.
    const { rerender } = render(<FieldHost key="local" worktreeId="wt-remount" />)
    act(() => field().field.onQueryChange('cart'))
    await advanceFakeClock()
    await act(async () => pending[0].resolve(resultFor('cart')))
    act(() => field().field.onQueryChange('cars'))
    rerender(<FieldHost key="runtime" worktreeId="wt-remount" />)
    expect(field().field.query).toBe('cars')
    await advanceFakeClock()
    expect(pending.at(-1)?.query).toBe('cars')
  })

  it('renders no global miss between a scan settling and its rows arriving', async () => {
    render(<FieldHost worktreeId="wt-deferred" />)
    act(() => field().field.onQueryChange('cart'))
    await advanceFakeClock()
    await act(async () => pending[0].resolve(resultFor('cart')))
    expect(mounted.renders.filter((keys) => keys.includes('no-results'))).toEqual([])
    expect(mounted.renders.at(-1)).toContain('match:/repo/cart.ts')
  })

  it('admits a seeded one-character query only until it is edited away', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-short' })
    useAppStore.getState().showRightSidebarSearch({ query: 'x' })
    render(<FieldHost worktreeId="wt-short" />)
    await advanceFakeClock()
    act(() => field().field.onQueryChange('xy'))
    await advanceFakeClock()
    act(() => field().field.onQueryChange('x'))
    await advanceFakeClock(1000)
    expect(pending.map((request) => request.query)).toEqual(['x', 'xy'])
  })

  it('never revives a draft after its workspace entry is purged or renamed away and back', () => {
    const first = render(<FieldHost worktreeId="wt-a" />)
    act(() => field().field.onQueryChange('cart'))
    first.unmount()
    const moveEntry = (from: string, to: string) =>
      useAppStore.setState((state) => {
        const { [from]: entry, ...rest } = state.fileSearchStateByWorktree
        return { fileSearchStateByWorktree: entry ? { ...rest, [to]: entry } : rest }
      })

    moveEntry('wt-a', 'wt-b')
    const renamed = render(<FieldHost worktreeId="wt-b" />)
    expect(field().field.query).toBe('')
    act(() => field().field.onQueryChange('zzz'))
    renamed.unmount()
    moveEntry('wt-b', 'wt-a')
    const back = render(<FieldHost worktreeId="wt-a" />)
    expect(field().field.query).toBe('')
    back.unmount()

    useAppStore.setState((state) => {
      const { ['wt-a']: _purged, ...rest } = state.fileSearchStateByWorktree
      return { fileSearchStateByWorktree: rest }
    })
    render(<FieldHost worktreeId="wt-a" />)
    expect(field().field.query).toBe('')
  })

  it('says text search is unavailable instead of No results when the scan is skipped', async () => {
    render(<FieldHost worktreeId="wt-skip" worktreePath={null} />)
    act(() => field().field.onQueryChange('cart'))
    await advanceFakeClock()
    const keys = mounted.renders.at(-1) ?? ''
    expect(keys).toContain('error:text')
    expect(keys).not.toContain('no-results')
    expect(field().field.loading).toBe(false)
    expect(pending).toEqual([])
    // The muted row is not a live region itself; the pane's persistent region carries this text.
    expect(field().announcement).toBe('Not available here')
  })

  it('keeps announcing the same notice while the user keeps typing', async () => {
    render(<FieldHost worktreeId="wt-skip-typing" worktreePath={null} />)
    act(() => field().field.onQueryChange('cart'))
    await advanceFakeClock()
    act(() => field().field.onQueryChange('carts'))
    await advanceFakeClock()
    act(() => field().field.onQueryChange('cartsx'))
    await advanceFakeClock()
    const first = mounted.announcements.indexOf('Not available here')
    expect(first).toBeGreaterThan(-1)
    // Each change of the live text is a new announcement; the notice must not drop between pauses.
    expect(mounted.announcements.slice(first)).not.toContain('')
  })
})
