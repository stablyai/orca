// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  favouriteTransport as transport,
  favourite,
  named,
  emptySaved,
  resetFavouriteTransport,
  useFavouriteTaskPage,
  type FavouriteFixtureProps
} from './__mocks__/task-page-jira-favourite-fixture'

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  resetFavouriteTransport()
})
async function open(result: { current: ReturnType<typeof useFavouriteTaskPage> }) {
  act(() => result.current.loadJiraFavouriteFilters())
  await waitFor(() => expect(result.current.jiraFavouriteFiltersLoading).toBe(false))
  await waitFor(() => expect(result.current.jiraSavedFiltersLoading).toBe(false))
}

it('loads only when opened, reuses the result, and refreshes only on explicit request', async () => {
  const { result, rerender } = renderHook(() => useFavouriteTaskPage())
  await waitFor(() => expect(result.current.jiraSavedFiltersLoading).toBe(false))
  expect(transport.catalogue).not.toHaveBeenCalled()
  await open(result)
  expect(transport.catalogue).toHaveBeenCalledTimes(1)
  act(() => result.current.loadJiraFavouriteFilters())
  rerender()
  expect(transport.catalogue).toHaveBeenCalledTimes(1)
  act(() => result.current.retryJiraFavouriteFilters())
  await waitFor(() => expect(transport.catalogue).toHaveBeenCalledTimes(2))
})

it.each(['unsupported', 'failed'] as const)(
  'settles %s with stable empty data and recovers only on retry',
  async (kind) => {
    if (kind === 'unsupported') {
      transport.catalogue.mockResolvedValueOnce({ supported: false })
    } else {
      transport.catalogue.mockRejectedValueOnce(new Error('Jira request timed out'))
    }
    const { result, rerender } = renderHook(() => useFavouriteTaskPage())
    await open(result)
    const empty = result.current.jiraFavouriteFilters
    expect(empty).toEqual([])
    expect(result.current.jiraFavouriteFiltersUnsupported).toBe(kind === 'unsupported')
    expect(Boolean(result.current.jiraFavouriteFiltersError)).toBe(kind === 'failed')
    for (let index = 0; index < 5; index += 1) {
      rerender()
    }
    expect(result.current.jiraFavouriteFilters).toBe(empty)
    expect(transport.catalogue).toHaveBeenCalledTimes(1)
    expect(transport.list).toHaveBeenCalledTimes(1)
    act(() => result.current.retryJiraFavouriteFilters())
    await waitFor(() => expect(result.current.jiraFavouriteFilters).toHaveLength(1))
    expect(result.current.jiraFavouriteFiltersUnsupported).toBe(false)
    expect(result.current.jiraFavouriteFiltersError).toBeNull()
  }
)

it.each(['owner', 'site'] as const)(
  'ignores a late catalogue response across %s A→B→A',
  async (kind) => {
    const old = Promise.withResolvers<{
      supported: true
      filters: (typeof favourite)[]
      truncated: boolean
    }>()
    transport.catalogue.mockReturnValueOnce(old.promise)
    const { result, rerender } = renderHook(
      (props: FavouriteFixtureProps) => useFavouriteTaskPage(props),
      { initialProps: {} }
    )
    act(() => result.current.loadJiraFavouriteFilters())
    expect(result.current.jiraFavouriteFiltersLoading).toBe(true)
    rerender(kind === 'owner' ? { hostId: 'runtime:owner-b' } : { siteId: 'site-b' })
    expect(result.current.jiraFavouriteFilters).toEqual([])
    rerender({})
    await open(result)
    const current = result.current.jiraFavouriteFilters
    await act(async () =>
      old.resolve({
        supported: true,
        filters: [{ ...favourite, name: 'Obsolete response' }],
        truncated: true
      })
    )
    expect(result.current.jiraFavouriteFilters).toBe(current)
    expect(result.current.jiraFavouriteFiltersTruncated).toBe(false)
  }
)

it('does not resurrect a selected favourite after site or owner changes', async () => {
  const { result, rerender } = renderHook(
    (props: FavouriteFixtureProps) => useFavouriteTaskPage(props),
    { initialProps: {} }
  )
  await open(result)
  await act(async () =>
    expect(
      await result.current.applyJiraFavouriteFilter(result.current.jiraFavouriteFilters[0])
    ).toBe(true)
  )
  transport.search.mockClear()
  rerender({ siteId: 'site-b' })
  expect(result.current.jiraFavouriteFilter).toBeNull()
  expect(transport.search).not.toHaveBeenCalled()
  rerender({})
  expect(result.current.jiraFavouriteFilter).toBeNull()
  await open(result)
  expect(transport.search).not.toHaveBeenCalled()
})

it('cancels a delayed named handoff when the user types a newer query', async () => {
  transport.readSaved.mockResolvedValue({ ...emptySaved, activeFilterId: named.id })
  const { result } = renderHook(() => useFavouriteTaskPage())
  await open(result)
  const pending = Promise.withResolvers<typeof emptySaved>()
  transport.mutateSaved.mockReturnValueOnce(pending.promise)
  let applying = Promise.resolve(false)
  act(() => {
    applying = result.current.applyJiraFavouriteFilter(result.current.jiraFavouriteFilters[0])
  })
  act(() => result.current.setJiraSearchInput('newer input'))
  await act(async () => {
    pending.resolve(emptySaved)
    expect(await applying).toBe(false)
  })
  expect(result.current.jiraSearchInput).toBe('newer input')
  expect(result.current.jiraFavouriteFilter).toBeNull()
  expect(result.current.jiraFavouriteFiltersError).toBeNull()
})

it('does not commit a delayed catalogue or named handoff after unmount', async () => {
  transport.readSaved.mockResolvedValue({ ...emptySaved, activeFilterId: named.id })
  const { result, unmount } = renderHook(() => useFavouriteTaskPage())
  await open(result)
  const pending = Promise.withResolvers<typeof emptySaved>()
  transport.mutateSaved.mockReturnValueOnce(pending.promise)
  const applying = result.current.applyJiraFavouriteFilter(result.current.jiraFavouriteFilters[0])
  unmount()
  pending.resolve(emptySaved)
  expect(await applying).toBe(false)
})

it('requires a successful current-lifetime named read after A→B→A before clearing selection', async () => {
  transport.readSaved.mockResolvedValueOnce({ ...emptySaved, activeFilterId: named.id })
  const { result, rerender } = renderHook(
    (props: FavouriteFixtureProps) => useFavouriteTaskPage(props),
    { initialProps: {} }
  )
  await open(result)
  expect(result.current.jiraSavedFiltersReady).toBe(true)
  transport.readSaved
    .mockReturnValueOnce(new Promise(() => {}))
    .mockRejectedValueOnce(new Error('Returning owner disconnected'))
  rerender({ hostId: 'runtime:owner-b' })
  rerender({})
  await open(result)
  await waitFor(() => expect(result.current.jiraSavedFiltersLoading).toBe(false))
  expect(result.current.jiraSavedFiltersReady).toBe(false)
  expect(result.current.jiraSavedFilters).toEqual([])
  await act(async () =>
    expect(
      await result.current.applyJiraFavouriteFilter(result.current.jiraFavouriteFilters[0])
    ).toBe(false)
  )
  expect(result.current.jiraFavouriteFilter).toBeNull()
  expect(transport.mutateSaved).not.toHaveBeenCalled()
})
