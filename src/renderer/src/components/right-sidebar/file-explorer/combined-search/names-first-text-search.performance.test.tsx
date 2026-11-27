// @vitest-environment happy-dom
// Perf contract (item 1972, follow-up to #49637): on a 105k-file repo the text scan started beside the
// file-name listing, and both walk the disk, so file names arrived 0.7-1.9 s later than before #49637.
// A text scan must not start while the live query's name listing is loading, and a keystroke must stop
// the previous scan at once. Fails with the names-first gate removed (7cbf4081ccc and its fix-ups).
import { act, render } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { seedLocalWorktree } from '../../../file-actions/quick-open/quick-open-file-list-test-harness'
import { useFileExplorerNameFilter } from '../panel/use-file-explorer-name-filter'
import {
  advanceFakeClock,
  cancelSearch,
  field,
  FieldHost,
  mounted,
  pending,
  resultFor
} from './combined-search-test-harness'
import { useCombinedSearch } from './useCombinedSearch'

const noop = (): void => {}
const NO_DRAFT = { text: '', allowShort: false, seeded: false }

/** The Files pane's two halves: the real name listing feeding the combined search. */
function NamesAndTextHost(): null {
  const [query, setQuery] = useState('')
  const names = useFileExplorerNameFilter({
    query,
    activeWorktreeId: 'wt-1',
    worktreePath: '/repo',
    displayRootPath: '/repo',
    showDotfiles: false
  })
  mounted.field = useCombinedSearch({
    activeWorktreeId: 'wt-1',
    worktreePath: '/repo',
    query,
    setQuery,
    nameMatches: names.nameMatches,
    namesLoading: names.nameFilterFiles.loading,
    namesError: names.nameFilterFiles.loadError,
    onOpenName: noop,
    onShowAllNames: noop,
    initial: NO_DRAFT
  })
  return null
}

function scannedQueries(): string[] {
  return pending.map((request) => request.query)
}

describe('names-first text scan', () => {
  it("holds the first query's scan until its name listing settles, then starts it without another pause", async () => {
    seedLocalWorktree()
    let settleListing: (paths: string[]) => void = noop
    Object.assign(window.api.fs, {
      listFiles: vi.fn(() => new Promise<string[]>((resolve) => (settleListing = resolve))),
      cancelListFiles: vi.fn(async () => undefined)
    })
    render(<NamesAndTextHost />)
    // The listing reports settled for one render before its request starts; that must not let text through.
    act(() => field().field.onQueryChange('cart'))
    await advanceFakeClock(1000)
    expect(scannedQueries()).toEqual([])

    await act(async () => settleListing(['src/cart.ts']))
    // The wait for names already covered the pause after typing.
    await advanceFakeClock(0)
    expect(scannedQueries()).toEqual(['cart'])
  })

  it('waits for the file-name listing before it starts the text scan', async () => {
    const { rerender } = render(<FieldHost worktreeId="wt-gate" namesLoading />)
    act(() => field().field.onQueryChange('cart'))
    await advanceFakeClock(1000)
    expect(scannedQueries()).toEqual([])
    // The Text header holds with no count while it waits, so nothing below it jumps.
    expect(mounted.renders.at(-1)).toBe('section:text')
    expect(field().field.loading).toBe(true)

    rerender(<FieldHost worktreeId="wt-gate" />)
    await advanceFakeClock()
    expect(scannedQueries()).toEqual(['cart'])
  })

  it('holds a seeded query, a restored draft and a toggle rerun behind the name listing too', async () => {
    useAppStore.setState({ activeWorktreeId: 'wt-seeded' })
    useAppStore.getState().showRightSidebarSearch({ query: 'cart' })
    const seeded = render(<FieldHost worktreeId="wt-seeded" namesLoading />)
    await advanceFakeClock(1000)
    act(() => field().field.onToggleCaseSensitive())
    await advanceFakeClock(1000)
    expect(scannedQueries()).toEqual([])
    seeded.rerender(<FieldHost worktreeId="wt-seeded" />)
    await advanceFakeClock()
    expect(scannedQueries()).toEqual(['cart'])
    seeded.unmount()

    // The remounted field restores the 'cart' draft and reruns it, once names settle.
    const restored = render(<FieldHost worktreeId="wt-seeded" namesLoading />)
    expect(field().field.query).toBe('cart')
    await advanceFakeClock(1000)
    expect(scannedQueries()).toEqual(['cart'])
    restored.rerender(<FieldHost worktreeId="wt-seeded" />)
    await advanceFakeClock()
    expect(scannedQueries()).toEqual(['cart', 'cart'])
  })

  it('stops a running text scan as soon as the next keystroke arrives', async () => {
    const { rerender } = render(<FieldHost worktreeId="wt-stop" />)
    act(() => field().field.onQueryChange('cart'))
    await advanceFakeClock()
    expect(scannedQueries()).toEqual(['cart'])

    rerender(<FieldHost worktreeId="wt-stop" namesLoading />)
    act(() => field().field.onQueryChange('cars'))
    // Cancelled before any timer runs, so the old scan never overlaps the new listing.
    expect(cancelSearch).toHaveBeenCalledTimes(1)
    await advanceFakeClock(1000)
    expect(scannedQueries()).toEqual(['cart'])
    await act(async () => pending[0].resolve(resultFor('cart')))
  })

  it('drops a text scan still waiting on names when the query is cleared', async () => {
    const { rerender } = render(<FieldHost worktreeId="wt-drop" namesLoading />)
    act(() => field().field.onQueryChange('cart'))
    act(() => field().field.onQueryChange(''))
    rerender(<FieldHost worktreeId="wt-drop" />)
    await advanceFakeClock(1000)
    expect(scannedQueries()).toEqual([])
  })
})
