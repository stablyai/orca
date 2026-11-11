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
} from '../../__mocks__/task-page-jira-favourite-fixture'

afterEach(cleanup)
beforeEach(() => {
  localStorage.clear()
  resetFavouriteTransport()
})

async function ready(result: { current: ReturnType<typeof useFavouriteTaskPage> }) {
  act(() => result.current.loadJiraFavouriteFilters())
  await waitFor(() => {
    expect(result.current.jiraSavedFiltersLoading).toBe(false)
    expect(result.current.jiraFavouriteFiltersLoading).toBe(false)
    expect(result.current.jiraLoading).toBe(false)
  })
}

it('waits for confirmed named deselection before changing query or linked mode', async () => {
  transport.readSaved.mockResolvedValue({ ...emptySaved, activeFilterId: named.id })
  const { result } = renderHook(() => useFavouriteTaskPage())
  await ready(result)
  act(() => result.current.setJiraHasWorkspace(true))
  const deferred = Promise.withResolvers<typeof emptySaved>()
  transport.mutateSaved.mockReturnValueOnce(deferred.promise)
  let applying = Promise.resolve(false)
  act(() => {
    applying = result.current.applyJiraFavouriteFilter(result.current.jiraFavouriteFilters[0])
  })
  expect(result.current.jiraFavouriteFilter).toBeNull()
  expect(result.current.jiraSearchInput).toBe(named.jql)
  expect(result.current.jiraHasWorkspace).toBe(true)
  await act(async () => {
    deferred.resolve(emptySaved)
    expect(await applying).toBe(true)
  })
  expect(result.current.jiraHasWorkspace).toBe(false)
  expect(result.current.jiraSearchInput).toBe('')
  expect(result.current.jiraFavouriteFilter?.id).toBe(favourite.id)
  expect(transport.mutateSaved).toHaveBeenCalledExactlyOnceWith(
    { kind: 'environment', environmentId: 'owner-a' },
    { kind: 'select', id: null }
  )
})

it.each(['site', 'owner', 'disabled'] as const)(
  'fences a delayed handoff across %s A→B→A',
  async (kind) => {
    transport.readSaved.mockResolvedValue({ ...emptySaved, activeFilterId: named.id })
    const { result, rerender } = renderHook(
      (props: FavouriteFixtureProps) => useFavouriteTaskPage(props),
      {
        initialProps: {}
      }
    )
    await ready(result)
    const deferred = Promise.withResolvers<typeof emptySaved>()
    transport.mutateSaved.mockReturnValueOnce(deferred.promise)
    let applying = Promise.resolve(false)
    act(() => {
      applying = result.current.applyJiraFavouriteFilter(result.current.jiraFavouriteFilters[0])
    })
    const other: FavouriteFixtureProps = {
      hostId: kind === 'owner' ? 'runtime:owner-b' : 'runtime:owner-a',
      siteId: kind === 'site' ? 'site-b' : 'site-a',
      enabled: kind !== 'disabled'
    }
    rerender(other)
    rerender({ hostId: 'runtime:owner-a', siteId: 'site-a', enabled: true })
    await ready(result)
    await act(async () => {
      deferred.resolve(emptySaved)
      expect(await applying).toBe(false)
    })
    expect(result.current.jiraFavouriteFilter).toBeNull()
    expect(result.current.jiraSearchInput).not.toContain('12345')
  }
)
