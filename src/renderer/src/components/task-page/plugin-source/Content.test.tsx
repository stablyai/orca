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
    create: true,
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

const FACETS = [
  { id: 'state', label: 'State', kind: 'multi', dynamic: true },
  { id: 'sprint', label: 'Sprint', kind: 'single', dynamic: true }
]

/** Neither id is any provider's vocabulary: core reads the declaration, not the
 *  spelling, and a fixture that borrowed a real one would hide a hardcoded id. */
const OWNER_FACET = { id: 'owner', label: 'Owner', kind: 'multi', dynamic: true }
const OWNER_OPTIONS = [
  { id: 'mine', label: 'Me' },
  { id: 'ada', label: 'Ada' }
]

const SCOPES = [
  { id: 'FabrikamOps/dashboards', name: 'FabrikamOps / Dashboards' },
  { id: 'contoso-labs/platform', name: 'contoso-labs / Platform' }
]

/** A source whose facets are all `dynamic`, so every option list is fetched for
 *  the scope on screen the way a real provider answers. */
function stubFacetSource(
  optionsByFacet: Record<string, { id: string; label: string }[]>,
  facets: unknown[] = FACETS
): ReturnType<typeof vi.fn> {
  const invoke = vi
    .fn()
    .mockImplementation(async (args: { method: string; params?: { facetId?: string } }) => {
      if (args.method === 'status') {
        return { ok: true, data: { ...STATUS, filters: undefined, facets } }
      }
      if (args.method === 'listScopes') {
        return { ok: true, data: SCOPES }
      }
      if (args.method === 'listFacetOptions') {
        return { ok: true, data: optionsByFacet[args.params?.facetId ?? ''] ?? [] }
      }
      return { ok: true, data: { items: [ITEM], nextCursor: null } }
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
      { id: 'FabrikamOps/dashboards', name: 'FabrikamOps / Dashboards' },
      { id: 'contoso-labs/platform', name: 'contoso-labs / Platform' }
    ])
    selectBoards()

    renderContent()

    await user.click(await screen.findByRole('combobox', { name: 'Projects' }))
    await user.click(screen.getByRole('option', { name: 'FabrikamOps / Dashboards' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith({
        ...BOARDS,
        method: 'listItems',
        params: {
          scopeIds: ['FabrikamOps/dashboards'],
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
      { id: 'FabrikamOps/dashboards', name: 'FabrikamOps / Dashboards' }
    ])
    selectBoards()

    renderContent()

    await user.click(await screen.findByRole('combobox', { name: 'Projects' }))
    await user.click(screen.getByRole('option', { name: 'FabrikamOps / Dashboards' }))
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'listItems',
          params: expect.objectContaining({ scopeIds: ['FabrikamOps/dashboards'] })
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
          scopeIds: ['FabrikamOps/dashboards'],
          search: null,
          cursor: null,
          limit: 50
        }
      })
      expect(invoke).toHaveBeenCalledWith({ ...BOARDS, method: 'listScopes' })
    })
  })

  it('offers the create control only to a source that declares supports.create', async () => {
    stubSource({ items: [ITEM] })
    selectBoards()

    renderContent()

    expect(await screen.findByRole('button', { name: 'New task' })).toBeInTheDocument()
  })

  it('renders no create control for a source that cannot create', async () => {
    stubSource({ items: [ITEM] }, { ...STATUS, supports: { ...STATUS.supports, create: false } })
    selectBoards()

    renderContent()

    expect(await screen.findByText('Ship the source bar')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument()
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

  it('renders a control per declared facet and fetches its options for the current scope', async () => {
    const invoke = stubFacetSource({ state: [{ id: 'Active', label: 'Active' }], sprint: [] })
    selectBoards()

    renderContent()

    expect(await screen.findByRole('combobox', { name: 'State' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Sprint' })).toBeInTheDocument()
    expect(invoke).toHaveBeenCalledWith({
      ...BOARDS,
      method: 'listFacetOptions',
      params: { facetId: 'state', scopeIds: [] }
    })
  })

  it('refetches facet options for the scope the user picks', async () => {
    const user = userEvent.setup()
    const invoke = stubFacetSource({ state: [{ id: 'Active', label: 'Active' }], sprint: [] })
    selectBoards()

    renderContent()

    await screen.findByRole('combobox', { name: 'State' })
    invoke.mockClear()

    await user.click(screen.getByRole('combobox', { name: 'Projects' }))
    await user.click(screen.getByRole('option', { name: 'FabrikamOps / Dashboards' }))

    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith({
          ...BOARDS,
          method: 'listFacetOptions',
          params: { facetId: 'state', scopeIds: ['FabrikamOps/dashboards'] }
        })
      },
      { timeout: 5000 }
    )
  })

  it('narrows the list on two facets at once', async () => {
    const user = userEvent.setup()
    const invoke = stubFacetSource({
      state: [{ id: 'Active', label: 'Active' }],
      sprint: [{ id: 'Sprint 1', label: 'Sprint 1' }]
    })
    selectBoards()

    renderContent()

    await user.click(await screen.findByRole('combobox', { name: 'State' }))
    await user.click(await screen.findByRole('option', { name: 'Active' }))
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('combobox', { name: 'Sprint' }))
    await user.click(await screen.findByRole('option', { name: 'Sprint 1' }))

    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith({
          ...BOARDS,
          method: 'listItems',
          params: {
            scopeIds: [],
            search: null,
            cursor: null,
            limit: 50,
            facetSelections: { state: ['Active'], sprint: ['Sprint 1'] }
          }
        })
      },
      { timeout: 5000 }
    )
  })

  it('drops a cleared facet from the request rather than sending an empty array', async () => {
    const user = userEvent.setup()
    const invoke = stubFacetSource({
      state: [{ id: 'Active', label: 'Active' }],
      sprint: [{ id: 'Sprint 1', label: 'Sprint 1' }]
    })
    selectBoards()

    renderContent()

    await user.click(await screen.findByRole('combobox', { name: 'State' }))
    await user.click(await screen.findByRole('option', { name: 'Active' }))
    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'listItems',
            params: expect.objectContaining({ facetSelections: { state: ['Active'] } })
          })
        )
      },
      { timeout: 5000 }
    )
    invoke.mockClear()

    await user.click(await screen.findByRole('option', { name: 'Clear' }))

    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith({
          ...BOARDS,
          method: 'listItems',
          params: { scopeIds: [], search: null, cursor: null, limit: 50 }
        })
      },
      { timeout: 5000 }
    )
  })

  it('opens a facet on the options its declaration defaults to', async () => {
    const invoke = stubFacetSource({ owner: OWNER_OPTIONS }, [
      { ...OWNER_FACET, defaultOptionIds: ['mine'] }
    ])
    selectBoards()

    renderContent()

    expect(await screen.findByRole('combobox', { name: 'Owner' })).toHaveTextContent('Owner: Me')
    await waitFor(
      () => {
        expect(invoke).toHaveBeenCalledWith({
          ...BOARDS,
          method: 'listItems',
          params: {
            scopeIds: [],
            search: null,
            cursor: null,
            limit: 50,
            facetSelections: { owner: ['mine'] }
          }
        })
      },
      { timeout: 5000 }
    )
  })

  it('opens unfiltered when the facet declares no default', async () => {
    const invoke = stubFacetSource({ owner: OWNER_OPTIONS }, [OWNER_FACET])
    selectBoards()

    renderContent()

    expect(await screen.findByRole('combobox', { name: 'Owner' })).toHaveTextContent('Owner')
    expect(invoke).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'listItems',
        params: expect.objectContaining({ facetSelections: expect.anything() })
      })
    )
  })

  // A default is a preference; the list is not. One naming an option this scope
  // cannot resolve is dropped, and the facet still renders its real options.
  it('renders the list when a declared default names an option the scope does not offer', async () => {
    const invoke = stubFacetSource({ owner: OWNER_OPTIONS }, [
      { ...OWNER_FACET, defaultOptionIds: ['retired'] }
    ])
    selectBoards()

    renderContent()

    expect(await screen.findByRole('combobox', { name: 'Owner' })).toHaveTextContent('Owner')
    expect(await screen.findByText(ITEM.title)).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'listItems',
        params: expect.objectContaining({ facetSelections: expect.anything() })
      })
    )
  })
  it('re-sends a surviving facet selection once its options settle', async () => {
    // Changing scope leaves the query untouched when the selection is still
    // valid in the new project, so the prune is a no-op. The load racing the
    // scope change carries no facet selections — nothing else would reload the
    // list, and it would sit unfiltered while the chip still claims a filter.
    const user = userEvent.setup()
    const invoke = stubFacetSource({ state: [{ id: 'Active', label: 'Active' }], sprint: [] })
    selectBoards()

    renderContent()

    await screen.findByRole('combobox', { name: 'State' })
    await user.click(screen.getByRole('combobox', { name: 'State' }))
    await user.click(await screen.findByRole('option', { name: 'Active' }))
    await screen.findByRole('combobox', { name: 'Projects' })

    invoke.mockClear()
    await user.click(screen.getByRole('combobox', { name: 'Projects' }))
    await user.click(await screen.findByRole('option', { name: 'FabrikamOps / Dashboards' }))

    await waitFor(
      () => {
        const withState = invoke.mock.calls.filter(
          ([args]) =>
            args.method === 'listItems' &&
            JSON.stringify(args.params?.facetSelections ?? {}) ===
              JSON.stringify({ state: ['Active'] })
        )
        expect(withState.length).toBeGreaterThan(0)
      },
      { timeout: 5000 }
    )
  })

  it('applies a restored facet filter to the list once its options settle', async () => {
    // The first load runs before any facet has settled, so it carries no
    // selections. A restored selection that is valid needs no pruning and no
    // seeding, so the query never changes — only the settling signal can bring
    // the list back in line with the chip.
    const invoke = stubFacetSource({ state: [{ id: 'Active', label: 'Active' }], sprint: [] })
    selectBoards()
    useAppStore.setState({
      pluginTaskSourceQuery: { search: null, filterId: null, facetSelections: { state: ['Active'] } }
    })

    renderContent()

    await screen.findByRole('combobox', { name: 'State' })
    await waitFor(
      () => {
        const withState = invoke.mock.calls.filter(
          ([args]) =>
            args.method === 'listItems' &&
            JSON.stringify(args.params?.facetSelections ?? {}) ===
              JSON.stringify({ state: ['Active'] })
        )
        expect(withState.length).toBeGreaterThan(0)
      },
      { timeout: 5000 }
    )
  })

  it('does not fire an extra unfiltered load when the facet declarations arrive', async () => {
    // Mount loads unfiltered (nothing has settled yet) and the settle reloads
    // with the selection. The declarations arriving in between must not count
    // as a third state, or every open costs a wasted list request.
    const invoke = stubFacetSource({ state: [{ id: 'Active', label: 'Active' }], sprint: [] })
    selectBoards()
    useAppStore.setState({
      pluginTaskSourceQuery: { search: null, filterId: null, facetSelections: { state: ['Active'] } }
    })

    renderContent()

    await screen.findByRole('combobox', { name: 'State' })
    await waitFor(
      () => {
        const filtered = invoke.mock.calls.filter(
          ([args]) =>
            args.method === 'listItems' &&
            JSON.stringify(args.params?.facetSelections ?? {}) ===
              JSON.stringify({ state: ['Active'] })
        )
        expect(filtered.length).toBeGreaterThan(0)
      },
      { timeout: 5000 }
    )
    const listCalls = invoke.mock.calls.filter(([args]) => args.method === 'listItems')
    expect(listCalls.length).toBeLessThanOrEqual(2)
  })

})
