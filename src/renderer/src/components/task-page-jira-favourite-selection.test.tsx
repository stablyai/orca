// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { UNRESOLVED_OWNER_HOST_ID } from '../../../shared/execution-host'
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

async function ready(result: { current: ReturnType<typeof useFavouriteTaskPage> }) {
  act(() => result.current.loadJiraFavouriteFilters())
  await waitFor(() => {
    expect(result.current.jiraSavedFiltersLoading).toBe(false)
    expect(result.current.jiraFavouriteFiltersLoading).toBe(false)
    expect(result.current.jiraLoading).toBe(false)
  })
}
async function select(result: { current: ReturnType<typeof useFavouriteTaskPage> }) {
  await act(async () =>
    expect(
      await result.current.applyJiraFavouriteFilter(result.current.jiraFavouriteFilters[0])
    ).toBe(true)
  )
  await waitFor(() => expect(result.current.jiraLoading).toBe(false))
}

it('runs an exact favourite on its captured owner/site without saving its JQL', async () => {
  const { result } = renderHook(() => useFavouriteTaskPage())
  await ready(result)
  expect(transport.catalogue).toHaveBeenCalledExactlyOnceWith(
    { kind: 'environment', environmentId: 'owner-a' },
    'site-a'
  )
  await select(result)
  expect(transport.search).toHaveBeenCalledExactlyOnceWith(favourite.jql, 50, {
    sourceContext: result.current.jiraTaskSourceContext,
    siteId: 'site-a',
    force: false
  })
  expect(result.current.jiraSearchInput).toBe('')
  expect(result.current.appliedJiraSearch).toBe('')
  expect(JSON.stringify(transport.resume.mock.calls)).not.toContain('12345')
  expect(transport.mutateSaved).not.toHaveBeenCalled()
  act(() => result.current.setJiraRefreshNonce((value) => value + 1))
  await waitFor(() => expect(transport.search).toHaveBeenCalledTimes(2))
  expect(transport.search.mock.lastCall?.[2].force).toBe(true)
})

it('composes same-site project and sprint while preserving exact JQL and ordering', async () => {
  const { result } = renderHook(() => useFavouriteTaskPage())
  await ready(result)
  act(() => {
    result.current.setJiraProjectFilter({ id: '77', key: 'APP', name: 'App', siteId: 'site-a' })
    result.current.setJiraCurrentSprint(true)
  })
  transport.search.mockClear()
  await select(result)
  expect(transport.search).toHaveBeenLastCalledWith(
    'project = "77" AND ((filter = 12345) AND sprint in openSprints()) ORDER BY updated DESC',
    50,
    { sourceContext: result.current.jiraTaskSourceContext, siteId: 'site-a', force: false }
  )
})

it('rejects a different-site project without sending favourite JQL anywhere', async () => {
  const { result } = renderHook(() => useFavouriteTaskPage())
  await ready(result)
  await select(result)
  transport.search.mockClear()
  act(() =>
    result.current.setJiraProjectFilter({ id: '77', key: 'OTHER', name: 'Other', siteId: 'site-b' })
  )
  await waitFor(() => expect(result.current.jiraError).not.toBeNull())
  expect(transport.search).not.toHaveBeenCalled()
})

it('does not reinterpret a rejected favourite as text', async () => {
  const { result } = renderHook(() => useFavouriteTaskPage())
  await ready(result)
  transport.search.mockRejectedValue(new Error('Error 400: Invalid favourite query'))
  await select(result)
  expect(transport.search).toHaveBeenCalledTimes(1)
  expect(result.current.jiraError?.details).toContain('Invalid favourite query')
})

it('clears the transient selection immediately when manual search changes, and never resumes it', async () => {
  const { result, unmount } = renderHook(() => useFavouriteTaskPage())
  await ready(result)
  await select(result)
  act(() => result.current.setJiraSearchInput('ordinary search'))
  expect(result.current.jiraFavouriteFilter).toBeNull()
  await waitFor(() => expect(result.current.appliedJiraSearch).toBe('ordinary search'))
  expect(JSON.stringify(transport.resume.mock.calls)).not.toContain('12345')
  unmount()
  const next = renderHook(() => useFavouriteTaskPage())
  await ready(next.result)
  expect(next.result.current.jiraFavouriteFilter).toBeNull()
})

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

it.each(['retained', 'rejected'] as const)(
  'keeps the named query when deselection is %s',
  async (failure) => {
    const selected = { ...emptySaved, activeFilterId: named.id }
    transport.readSaved.mockResolvedValue(selected)
    const { result } = renderHook(() => useFavouriteTaskPage())
    await ready(result)
    if (failure === 'retained') {
      transport.mutateSaved.mockResolvedValueOnce(selected)
    } else {
      transport.mutateSaved.mockRejectedValueOnce(new Error('Host unavailable'))
    }
    await act(async () =>
      expect(
        await result.current.applyJiraFavouriteFilter(result.current.jiraFavouriteFilters[0])
      ).toBe(false)
    )
    expect(result.current.jiraFavouriteFilter).toBeNull()
    expect(result.current.jiraSearchInput).toBe(named.jql)
    expect(result.current.jiraFavouriteFiltersError).not.toBeNull()
  }
)

it('prevents favourite application while an existing named apply or refresh is pending', async () => {
  const { result } = renderHook(() => useFavouriteTaskPage())
  await ready(result)
  const deferred = Promise.withResolvers<typeof emptySaved>()
  transport.mutateSaved.mockReturnValueOnce(deferred.promise)
  let applying = Promise.resolve(false)
  act(() => {
    applying = result.current.applyJiraSavedFilter(named)
  })
  await act(async () =>
    expect(
      await result.current.applyJiraFavouriteFilter(result.current.jiraFavouriteFilters[0])
    ).toBe(false)
  )
  await act(async () => {
    deferred.resolve({ ...emptySaved, activeFilterId: named.id })
    await applying
  })
  expect(result.current.jiraFavouriteFilter).toBeNull()
  const read = Promise.withResolvers<typeof emptySaved>()
  transport.readSaved.mockReturnValueOnce(read.promise)
  act(() => result.current.retryJiraSavedFilters())
  await act(async () =>
    expect(
      await result.current.applyJiraFavouriteFilter(result.current.jiraFavouriteFilters[0])
    ).toBe(false)
  )
  await act(async () => read.resolve(emptySaved))
})

it('a later named selection clears the favourite and restores named exact JQL', async () => {
  const { result } = renderHook(() => useFavouriteTaskPage())
  await ready(result)
  await select(result)
  await act(async () => expect(await result.current.applyJiraSavedFilter(named)).toBe(true))
  expect(result.current.jiraFavouriteFilter).toBeNull()
  expect(result.current.appliedJiraSearch).toBe(named.jql)
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

it.each(['all', 'unresolved'] as const)('does no catalogue read for %s', async (kind) => {
  const { result } = renderHook(() =>
    useFavouriteTaskPage({
      siteId: kind === 'all' ? 'all' : 'site-a',
      hostId: kind === 'unresolved' ? UNRESOLVED_OWNER_HOST_ID : 'runtime:owner-a'
    })
  )
  await waitFor(() => expect(result.current.jiraSavedFiltersLoading).toBe(false))
  expect(transport.catalogue).not.toHaveBeenCalled()
  expect(result.current.jiraFavouriteFiltersEnabled).toBe(false)
})
