// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'
import type {
  PluginTaskSourceFilter,
  PluginTaskSourceLoadError,
  PluginTaskSourceQuery
} from '@/store/slices/plugin-task-sources-slice-contract'
import type { PluginTaskSourceCreateControl } from './CreateItemDialog'
import { TaskPagePluginSourceList } from './List'
import type { PluginTaskSourceScopeFilter } from './ScopePicker'

afterEach(cleanup)

const UNFILTERED: PluginTaskSourceQuery = { search: null, filterId: null, facetSelections: {} }
const NO_SCOPES: PluginTaskSourceScopeFilter = {
  scopes: [],
  selectedScopeIds: [],
  loading: false,
  error: null,
  onScopeIdsChange: () => {}
}

function taskItem(overrides: Partial<PluginTaskItem> = {}): PluginTaskItem {
  return {
    id: 'item-1',
    key: 'BOARD-7',
    title: 'Ship the source bar',
    state: { name: 'In Progress', category: 'in-progress' },
    assignee: { id: 'u1', displayName: 'Ada Lovelace', avatarUrl: null },
    url: null,
    updatedAt: null,
    scopeId: null,
    ...overrides
  }
}

function renderList(
  props: {
    items?: PluginTaskItem[]
    loading?: boolean
    error?: PluginTaskSourceLoadError | null
    filters?: PluginTaskSourceFilter[]
    query?: PluginTaskSourceQuery
    onQueryChange?: (query: PluginTaskSourceQuery) => void
    scopeFilter?: PluginTaskSourceScopeFilter
    onUseItem?: (item: PluginTaskItem) => void
    refreshing?: boolean
    onRefresh?: () => void
    create?: PluginTaskSourceCreateControl | null
  } = {}
): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <TaskPagePluginSourceList
        title="Boards"
        items={props.items ?? []}
        loading={props.loading ?? false}
        error={props.error ?? null}
        filters={props.filters ?? []}
        facets={[]}
        facetOptions={{}}
        query={props.query ?? UNFILTERED}
        onQueryChange={props.onQueryChange ?? vi.fn()}
        scopeFilter={props.scopeFilter ?? NO_SCOPES}
        onUseItem={props.onUseItem ?? vi.fn()}
        refreshing={props.refreshing ?? false}
        onRefresh={props.onRefresh ?? vi.fn()}
        create={props.create ?? null}
      />
    </TooltipProvider>
  )
}

describe('TaskPage contributed source table', () => {
  it('renders the column header for every contributed field', () => {
    renderList({ items: [taskItem()] })

    for (const column of ['Key', 'Issue', 'Status', 'Priority', 'Assignee', 'Updated']) {
      expect(screen.getByText(column)).toBeInTheDocument()
    }
  })

  it('renders key, title, state, priority, labels and assignee for an item that has them', () => {
    renderList({
      items: [
        taskItem({
          priority: 'High',
          labels: ['backend', 'urgent'],
          updatedAt: new Date().toISOString()
        })
      ]
    })

    expect(screen.getAllByText('BOARD-7').length).toBeGreaterThan(0)
    expect(screen.getByText('Ship the source bar')).toBeInTheDocument()
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0)
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByText('backend')).toBeInTheDocument()
    expect(screen.getByText('urgent')).toBeInTheDocument()
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0)
  })

  it('degrades to an empty cell when the provider carries no priority or labels', () => {
    renderList({ items: [taskItem({ priority: null })] })

    expect(screen.getByRole('button', { name: 'BOARD-7 Ship the source bar' })).toBeInTheDocument()
    expect(screen.queryByText('undefined')).not.toBeInTheDocument()
    expect(screen.queryByText('null')).not.toBeInTheDocument()
  })

  it('groups rows by state with a count on each group', () => {
    renderList({
      items: [
        taskItem({ id: 'a', key: 'BOARD-1' }),
        taskItem({ id: 'b', key: 'BOARD-2' }),
        taskItem({ id: 'c', key: 'BOARD-3', state: { name: 'To Do', category: 'todo' } })
      ]
    })

    const inProgress = screen.getByRole('button', { name: /In Progress/ })
    const todo = screen.getByRole('button', { name: /To Do/ })
    expect(within(inProgress).getByText('2')).toBeInTheDocument()
    expect(within(todo).getByText('1')).toBeInTheDocument()
  })

  it('collapses and re-expands a group', async () => {
    const user = userEvent.setup()
    renderList({ items: [taskItem({ id: 'a', key: 'BOARD-1' })] })

    const group = screen.getByRole('button', { name: /In Progress/ })
    expect(screen.getByRole('button', { name: 'BOARD-1 Ship the source bar' })).toBeInTheDocument()

    await user.click(group)
    expect(
      screen.queryByRole('button', { name: 'BOARD-1 Ship the source bar' })
    ).not.toBeInTheDocument()

    await user.click(group)
    expect(screen.getByRole('button', { name: 'BOARD-1 Ship the source bar' })).toBeInTheDocument()
  })

  it('renders the error message instead of an empty-list state', () => {
    renderList({ error: { code: 'unauthorized', message: 'Board token expired.' } })

    expect(screen.getByRole('alert')).toHaveTextContent('Board token expired.')
    expect(screen.queryByText('No tasks found')).not.toBeInTheDocument()
  })

  it('shows the loading treatment before any item arrives', () => {
    const { container } = renderList({ loading: true })

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0)
    expect(screen.queryByText('No tasks found')).not.toBeInTheDocument()
  })

  it('reports an empty board only when the source succeeded', () => {
    renderList()

    expect(screen.getByText('No tasks found')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders no chip row for a source that declares no filters', () => {
    renderList({ items: [taskItem()] })

    expect(screen.queryByRole('group', { name: 'Filters' })).not.toBeInTheDocument()
  })

  it('opens the detail panel for the clicked row', async () => {
    const user = userEvent.setup()
    const item = taskItem({ id: 'item-2', key: 'BOARD-9' })
    renderList({ items: [taskItem(), item] })

    await user.click(screen.getByRole('button', { name: 'BOARD-9 Ship the source bar' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('seeds a workspace from the row action, not from the row itself', async () => {
    const user = userEvent.setup()
    const onUseItem = vi.fn()
    const item = taskItem({ id: 'item-2', key: 'BOARD-9' })
    renderList({ items: [taskItem(), item], onUseItem })

    await user.click(screen.getByRole('button', { name: 'Start workspace from BOARD-9' }))

    expect(onUseItem).toHaveBeenCalledWith(item)
  })

  it('invokes the refresh callback when the refresh button is clicked', async () => {
    const user = userEvent.setup()
    const onRefresh = vi.fn()
    renderList({ items: [taskItem()], onRefresh })

    await user.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('disables the refresh button and spins its icon while refreshing', () => {
    const { container } = renderList({ items: [taskItem()], refreshing: true })

    const button = screen.getByRole('button', { name: 'Refresh' })
    expect(button).toBeDisabled()
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })
})
