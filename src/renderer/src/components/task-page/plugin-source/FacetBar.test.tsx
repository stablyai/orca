// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { PluginTaskFacet } from '../../../../../shared/plugins/plugin-task-source-contract'
import type { PluginTaskSourceFacetOptions } from '@/store/slices/plugin-task-sources-slice-contract'
import { TaskPagePluginSourceFacetBar } from './FacetBar'

afterEach(cleanup)

const STATE: PluginTaskFacet = { id: 'state', label: 'State', kind: 'multi', dynamic: true }
const SPRINT: PluginTaskFacet = { id: 'sprint', label: 'Sprint', kind: 'single', dynamic: true }

const STATE_READY: PluginTaskSourceFacetOptions = {
  status: 'ready',
  options: [
    { id: 'Active', label: 'Active' },
    { id: 'New', label: 'New' }
  ]
}
const SPRINT_READY: PluginTaskSourceFacetOptions = {
  status: 'ready',
  options: [
    { id: 'Sprint 1', label: 'Sprint 1' },
    { id: 'Sprint 2', label: 'Sprint 2' }
  ]
}

function renderBar(
  props: {
    facets?: PluginTaskFacet[]
    facetOptions?: Record<string, PluginTaskSourceFacetOptions>
    facetSelections?: Record<string, string[]>
  } = {}
): { onFacetSelectionsChange: ReturnType<typeof vi.fn> } {
  const onFacetSelectionsChange = vi.fn()
  render(
    <TooltipProvider>
      <TaskPagePluginSourceFacetBar
        facets={props.facets ?? [STATE, SPRINT]}
        facetOptions={props.facetOptions ?? { state: STATE_READY, sprint: SPRINT_READY }}
        facetSelections={props.facetSelections ?? {}}
        onFacetSelectionsChange={onFacetSelectionsChange}
      />
    </TooltipProvider>
  )
  return { onFacetSelectionsChange }
}

describe('TaskPage contributed source facet bar', () => {
  it('renders one control per declared facet', () => {
    renderBar()

    expect(screen.getByRole('combobox', { name: 'State' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Sprint' })).toBeInTheDocument()
  })

  it('renders no bar at all for a source that declares no facets', () => {
    renderBar({ facets: [], facetOptions: {} })

    expect(screen.queryByRole('group', { name: 'Filters' })).not.toBeInTheDocument()
  })

  it('reports the chosen options of one facet', async () => {
    const user = userEvent.setup()
    const { onFacetSelectionsChange } = renderBar()

    await user.click(screen.getByRole('combobox', { name: 'State' }))
    await user.click(screen.getByRole('option', { name: 'Active' }))

    expect(onFacetSelectionsChange).toHaveBeenCalledWith({ state: ['Active'] })
  })

  it('composes selections across two facets rather than replacing one with the other', async () => {
    const user = userEvent.setup()
    const { onFacetSelectionsChange } = renderBar({ facetSelections: { state: ['Active'] } })

    await user.click(screen.getByRole('combobox', { name: 'Sprint' }))
    await user.click(screen.getByRole('option', { name: 'Sprint 1' }))

    expect(onFacetSelectionsChange).toHaveBeenCalledWith({
      state: ['Active'],
      sprint: ['Sprint 1']
    })
  })

  it('replaces the selection of a single facet rather than accumulating', async () => {
    const user = userEvent.setup()
    const { onFacetSelectionsChange } = renderBar({ facetSelections: { sprint: ['Sprint 1'] } })

    await user.click(screen.getByRole('combobox', { name: 'Sprint' }))
    await user.click(screen.getByRole('option', { name: 'Sprint 2' }))

    expect(onFacetSelectionsChange).toHaveBeenCalledWith({ sprint: ['Sprint 2'] })
  })

  it('drops a cleared facet from the selection rather than sending an empty array', async () => {
    const user = userEvent.setup()
    const { onFacetSelectionsChange } = renderBar({
      facetSelections: { state: ['Active'], sprint: ['Sprint 1'] }
    })

    await user.click(screen.getByRole('combobox', { name: 'State' }))
    await user.click(screen.getByRole('option', { name: 'Clear' }))

    expect(onFacetSelectionsChange).toHaveBeenCalledWith({ sprint: ['Sprint 1'] })
  })

  it('clears every facet at once', async () => {
    const user = userEvent.setup()
    const { onFacetSelectionsChange } = renderBar({
      facetSelections: { state: ['Active'], sprint: ['Sprint 1'] }
    })

    await user.click(screen.getByRole('button', { name: 'Clear all' }))

    expect(onFacetSelectionsChange).toHaveBeenCalledWith({})
  })

  it('offers no clear-all while no facet narrows anything', () => {
    renderBar()

    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument()
  })

  it('names the active narrowing on the closed control', () => {
    renderBar({ facetSelections: { state: ['Active', 'New'] } })

    expect(screen.getByRole('combobox', { name: 'State' })).toHaveTextContent('State: 2 selected')
    expect(screen.getByRole('combobox', { name: 'Sprint' })).toHaveTextContent('Sprint')
  })

  it('shows an in-flight facet as loading rather than as a ready control', () => {
    renderBar({ facetOptions: { state: { status: 'loading' }, sprint: SPRINT_READY } })

    const loading = screen.getByRole('button', { name: 'State' })
    expect(loading).toBeDisabled()
    expect(loading).toHaveTextContent('Loading...')
  })

  it('surfaces a failed option fetch instead of a facet that looks like it matches nothing', () => {
    renderBar({
      facetOptions: {
        state: {
          status: 'failed',
          error: { code: 'unauthorized', message: 'Board token expired.' }
        },
        sprint: SPRINT_READY
      }
    })

    expect(screen.getByRole('status')).toHaveTextContent('State unavailable')
    expect(screen.queryByRole('combobox', { name: 'State' })).not.toBeInTheDocument()
  })

  it('says a facet offers no options here rather than showing an empty list', async () => {
    const user = userEvent.setup()
    renderBar({ facetOptions: { state: { status: 'ready', options: [] }, sprint: SPRINT_READY } })

    await user.click(screen.getByRole('combobox', { name: 'State' }))

    expect(screen.getByText('No options for this selection.')).toBeInTheDocument()
  })
})
