// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { TaskPagePluginSourceContent } from './Content'

const BOARDS = { pluginKey: 'orca-samples.issues', sourceId: 'boards' }

const ITEM = {
  id: 'item-1',
  key: 'BOARD-7',
  title: 'Ship the source bar',
  state: { name: 'In Progress', category: 'in-progress' },
  assignee: null,
  url: null,
  updatedAt: null,
  scopeId: null
}

const STATUS = {
  connected: true,
  accountLabel: 'Boards',
  notice: null,
  supports: {
    comment: false,
    transition: false,
    assign: false,
    editTitle: false,
    editDescription: false
  },
  filters: [
    { id: 'assigned', label: 'Assigned to me' },
    { id: 'open', label: 'All open' }
  ]
}

function stubInvokeTaskSource(invoke: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal(
    'window',
    Object.assign(globalThis.window, {
      api: { plugins: { invokeTaskSource: invoke } }
    })
  )
}

/** Routes by method so the status probe, the scope probe and the item load each
 *  see their own payload, the way a real source answers them. */
function stubSource(
  page: { items: unknown[] },
  status: unknown = STATUS,
  scopes: unknown = []
): ReturnType<typeof vi.fn> {
  const invoke = vi.fn().mockImplementation(async (args: { method: string }) => {
    if (args.method === 'status') {
      return { ok: true, data: status }
    }
    if (args.method === 'listScopes') {
      return { ok: true, data: scopes }
    }
    return { ok: true, data: { items: page.items, nextCursor: null } }
  })
  stubInvokeTaskSource(invoke)
  return invoke
}

function renderContent(): void {
  render(
    <TooltipProvider>
      <TaskPagePluginSourceContent />
    </TooltipProvider>
  )
}

function selectBoards(): void {
  useAppStore.setState({ pluginTaskSources: [{ ...BOARDS, title: 'Boards' }] })
  useAppStore.getState().selectPluginTaskSource(BOARDS)
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('TaskPage contributed source content', () => {
  it('lists the selected source items it loads through the plugin bridge', async () => {
    const invoke = stubSource({ items: [ITEM] })
    selectBoards()

    renderContent()

    expect(await screen.findByText('Ship the source bar')).toBeInTheDocument()
    expect(screen.getByText('Boards')).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ ...BOARDS, method: 'listItems' }))
  })

  it('renders a chip per declared filter and reloads with the selected filter id', async () => {
    const user = userEvent.setup()
    const invoke = stubSource({ items: [ITEM] })
    selectBoards()

    renderContent()

    await user.click(await screen.findByRole('button', { name: 'All open' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith({
        ...BOARDS,
        method: 'listItems',
        params: { scopeIds: [], search: null, cursor: null, limit: 50, filterId: 'open' }
      })
    })
  })

  it('renders no chip row for a source that declares no filters', async () => {
    stubSource({ items: [ITEM] }, { ...STATUS, filters: undefined })
    selectBoards()

    renderContent()

    expect(await screen.findByText('Ship the source bar')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Filters' })).not.toBeInTheDocument()
  })

  it('offers the scopes the source declares and reloads items in the picked one', async () => {
    const user = userEvent.setup()
    const invoke = stubSource({ items: [ITEM] }, STATUS, [
      { id: 'NssfDevOps/dashboards', name: 'NssfDevOps / Dashboards' },
      { id: 'nssf-dolphin/platform', name: 'nssf-dolphin / Platform' }
    ])
    selectBoards()

    renderContent()

    await user.click(await screen.findByRole('combobox', { name: 'Projects' }))
    await user.click(screen.getByRole('option', { name: 'NssfDevOps / Dashboards' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith({
        ...BOARDS,
        method: 'listItems',
        params: {
          scopeIds: ['NssfDevOps/dashboards'],
          search: null,
          cursor: null,
          limit: 50
        }
      })
    })
  })

  it('renders no scope picker for a source that declares no scopes', async () => {
    stubSource({ items: [ITEM] })
    selectBoards()

    renderContent()

    expect(await screen.findByText('Ship the source bar')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Projects' })).not.toBeInTheDocument()
  })

  it('refreshes items and scopes with the current selection when the refresh button is clicked', async () => {
    const user = userEvent.setup()
    const invoke = stubSource({ items: [ITEM] }, STATUS, [
      { id: 'NssfDevOps/dashboards', name: 'NssfDevOps / Dashboards' }
    ])
    selectBoards()

    renderContent()

    await user.click(await screen.findByRole('combobox', { name: 'Projects' }))
    await user.click(screen.getByRole('option', { name: 'NssfDevOps / Dashboards' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'listItems',
          params: expect.objectContaining({ scopeIds: ['NssfDevOps/dashboards'] })
        })
      )
    })
    invoke.mockClear()

    await user.click(await screen.findByRole('button', { name: 'Refresh' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith({
        ...BOARDS,
        method: 'listItems',
        params: {
          scopeIds: ['NssfDevOps/dashboards'],
          search: null,
          cursor: null,
          limit: 50
        }
      })
      expect(invoke).toHaveBeenCalledWith({ ...BOARDS, method: 'listScopes' })
    })
  })

  it('surfaces a load failure instead of an empty board', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: false,
      code: 'unauthorized',
      message: 'Board token expired.'
    })
    stubInvokeTaskSource(invoke)
    selectBoards()

    renderContent()

    expect(await screen.findByRole('alert')).toHaveTextContent('Board token expired.')
    expect(screen.queryByText('No tasks found')).not.toBeInTheDocument()
  })
})
