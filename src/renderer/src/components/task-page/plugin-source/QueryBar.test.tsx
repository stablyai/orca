// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { PluginTaskSourceQuery } from '@/store/slices/plugin-task-sources-slice-contract'
import { PLUGIN_TASK_SOURCE_SEARCH_DEBOUNCE_MS, TaskPagePluginSourceQueryBar } from './QueryBar'
import type { PluginTaskSourceScopeFilter } from './ScopePicker'

const UNFILTERED: PluginTaskSourceQuery = { search: null, filterId: null }
const NO_SCOPES: PluginTaskSourceScopeFilter = {
  scopes: [],
  selectedScopeIds: [],
  loading: false,
  error: null,
  onScopeIdsChange: () => {}
}
const FILTERS = [
  { id: 'assigned', label: 'Assigned to me' },
  { id: 'open', label: 'All open' }
]

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TaskPage contributed source query bar', () => {
  it('renders no chip row when the source declares no filters', () => {
    render(
      <TaskPagePluginSourceQueryBar
        filters={[]}
        query={UNFILTERED}
        onQueryChange={vi.fn()}
        scopeFilter={NO_SCOPES}
      />
    )

    expect(screen.queryByRole('group', { name: 'Filters' })).not.toBeInTheDocument()
  })

  it('reports the declared filter id when its chip is selected', async () => {
    const user = userEvent.setup()
    const onQueryChange = vi.fn()
    render(
      <TaskPagePluginSourceQueryBar
        filters={FILTERS}
        query={UNFILTERED}
        onQueryChange={onQueryChange}
        scopeFilter={NO_SCOPES}
      />
    )

    await user.click(screen.getByRole('button', { name: 'All open' }))
    expect(onQueryChange).toHaveBeenCalledWith({ search: null, filterId: 'open' })
  })

  it('clears the filter when the active chip is pressed again', async () => {
    const user = userEvent.setup()
    const onQueryChange = vi.fn()
    render(
      <TaskPagePluginSourceQueryBar
        filters={FILTERS}
        query={{ search: null, filterId: 'open' }}
        onQueryChange={onQueryChange}
        scopeFilter={NO_SCOPES}
      />
    )

    await user.click(screen.getByRole('button', { name: 'All open' }))
    expect(onQueryChange).toHaveBeenCalledWith({ search: null, filterId: null })
  })

  it('debounces typing into one search query rather than one per keystroke', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onQueryChange = vi.fn()
    render(
      <TaskPagePluginSourceQueryBar
        filters={[]}
        query={UNFILTERED}
        onQueryChange={onQueryChange}
        scopeFilter={NO_SCOPES}
      />
    )

    await user.type(screen.getByRole('textbox', { name: 'Search tasks...' }), 'bar')
    expect(onQueryChange).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(PLUGIN_TASK_SOURCE_SEARCH_DEBOUNCE_MS)
    expect(onQueryChange).toHaveBeenCalledTimes(1)
    expect(onQueryChange).toHaveBeenCalledWith({ search: 'bar', filterId: null })
  })

  it('reports a cleared search as no search at all', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const onQueryChange = vi.fn()
    render(
      <TaskPagePluginSourceQueryBar
        filters={[]}
        query={{ search: 'bar', filterId: null }}
        onQueryChange={onQueryChange}
        scopeFilter={NO_SCOPES}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Clear search' }))
    await vi.advanceTimersByTimeAsync(PLUGIN_TASK_SOURCE_SEARCH_DEBOUNCE_MS)

    expect(onQueryChange).toHaveBeenCalledWith({ search: null, filterId: null })
  })
})
