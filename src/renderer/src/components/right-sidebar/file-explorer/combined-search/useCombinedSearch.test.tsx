// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { SearchResult } from '../../../../../../shared/file-search/code-search-types'
import { getInitialSearchDraft } from './use-search-draft-lifecycle'
import { useCombinedSearch } from './useCombinedSearch'

const initial = useAppStore.getState()
const pending: { query: string; resolve: (result: SearchResult) => void }[] = []
const cancelSearch = vi.fn(async () => undefined)
const noop = (): void => {}

function resultFor(query: string): SearchResult {
  return {
    totalMatches: 1,
    truncated: false,
    files: [
      {
        filePath: `/repo/${query}.ts`,
        relativePath: `${query}.ts`,
        matches: [{ line: 1, column: 1, matchLength: query.length, lineContent: query }]
      }
    ]
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  pending.length = 0
  cancelSearch.mockClear()
  Object.assign(window, {
    api: {
      ...window.api,
      fs: {
        search: (options: { query: string }) =>
          new Promise<SearchResult>((resolve) => pending.push({ query: options.query, resolve })),
        cancelSearch
      }
    }
  })
})

afterEach(() => {
  cleanup()
  mounted.field = null
  mounted.renders = []
  mounted.announcements = []
  vi.useRealTimers()
  useAppStore.setState(initial, true)
})

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

type FieldState = ReturnType<typeof useCombinedSearch>
const mounted: { field: FieldState | null; renders: string[]; announcements: string[] } = {
  field: null,
  renders: [],
  announcements: []
}

function FieldHost({
  worktreeId,
  worktreePath = '/repo',
  namesLoading = false
}: {
  worktreeId: string
  worktreePath?: string | null
  namesLoading?: boolean
}): null {
  const [start] = useState(() => getInitialSearchDraft(worktreeId))
  const [query, setQuery] = useState(start.text)
  mounted.field = useCombinedSearch({
    activeWorktreeId: worktreeId,
    worktreePath,
    query,
    setQuery,
    nameMatches: query.trim() && !namesLoading ? { total: 0, matches: [] } : null,
    namesLoading,
    namesError: null,
    onOpenName: noop,
    onShowAllNames: noop,
    initial: start
  })
  const { model } = mounted.field.results
  mounted.renders.push(Array.from({ length: model.count }, (_, i) => model.getKey(i)).join(','))
  mounted.announcements.push(mounted.field.announcement)
  return null
}

function field(): FieldState {
  if (!mounted.field) {
    throw new Error('field not mounted')
  }
  return mounted.field
}

function textRowKeys(result: Field): string[] {
  const { model } = result.current.results
  return Array.from({ length: model.count }, (_, index) => model.getKey(index)).filter(
    (key) => key.startsWith('file:') || key.startsWith('match:')
  )
}

async function advanceFakeClock(ms = 300): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
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

describe('combined search names-first text scan', () => {
  it('waits for the file-name listing before it starts the text scan', async () => {
    const { rerender } = render(<FieldHost worktreeId="wt-gate" namesLoading />)
    act(() => field().field.onQueryChange('cart'))
    await advanceFakeClock(1000)
    // On a large repo both are disk walks; names must not share the disk with text.
    expect(pending).toEqual([])
    // The Text header holds with no count while it waits, so nothing below it jumps.
    expect(mounted.renders.at(-1)).toBe('section:text')
    expect(field().field.loading).toBe(true)

    rerender(<FieldHost worktreeId="wt-gate" />)
    await advanceFakeClock()
    expect(pending.map((request) => request.query)).toEqual(['cart'])
  })

  it('stops a running text scan as soon as the next keystroke arrives', async () => {
    const { rerender } = render(<FieldHost worktreeId="wt-stop" />)
    act(() => field().field.onQueryChange('cart'))
    await advanceFakeClock()
    expect(pending.map((request) => request.query)).toEqual(['cart'])

    rerender(<FieldHost worktreeId="wt-stop" namesLoading />)
    act(() => field().field.onQueryChange('cars'))
    // Cancelled before any timer runs, so the old scan never overlaps the new listing.
    expect(cancelSearch).toHaveBeenCalledTimes(1)
    await advanceFakeClock(1000)
    expect(pending).toHaveLength(1)
  })

  it('drops a text scan still waiting on names when the query is cleared', async () => {
    const { rerender } = render(<FieldHost worktreeId="wt-drop" namesLoading />)
    act(() => field().field.onQueryChange('cart'))
    act(() => field().field.onQueryChange(''))
    rerender(<FieldHost worktreeId="wt-drop" />)
    await advanceFakeClock(1000)
    expect(pending).toEqual([])
  })
})
