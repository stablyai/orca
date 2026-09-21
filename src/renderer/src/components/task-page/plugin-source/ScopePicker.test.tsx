// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { PluginTaskScope } from '../../../../../shared/plugins/plugin-task-source-contract'
import type { PluginTaskSourceLoadError } from '@/store/slices/plugin-task-sources-slice-contract'
import { TaskPagePluginSourceScopePicker } from './ScopePicker'

afterEach(cleanup)

const SCOPES: PluginTaskScope[] = [
  { id: 'NssfDevOps/dashboards', name: 'NssfDevOps / Dashboards' },
  { id: 'NssfDevOps/redesign', name: 'NssfDevOps / NssfGo-Redesign' },
  { id: 'nssf-dolphin/platform', name: 'nssf-dolphin / Platform' }
]

function renderPicker(
  props: {
    scopes?: PluginTaskScope[]
    selectedScopeIds?: string[]
    loading?: boolean
    error?: PluginTaskSourceLoadError | null
    onScopeIdsChange?: (scopeIds: string[]) => void
  } = {}
): { onScopeIdsChange: ReturnType<typeof vi.fn> } {
  const onScopeIdsChange = vi.fn()
  render(
    <TooltipProvider>
      <TaskPagePluginSourceScopePicker
        scopes={props.scopes ?? SCOPES}
        selectedScopeIds={props.selectedScopeIds ?? []}
        loading={props.loading ?? false}
        error={props.error ?? null}
        onScopeIdsChange={props.onScopeIdsChange ?? onScopeIdsChange}
      />
    </TooltipProvider>
  )
  return { onScopeIdsChange }
}

async function openPicker(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup()
  await user.click(screen.getByRole('combobox', { name: 'Projects' }))
  return user
}

describe('TaskPage contributed source scope picker', () => {
  it('renders every scope the source declared, named as the source named it', async () => {
    renderPicker()
    await openPicker()

    for (const scope of SCOPES) {
      expect(screen.getByText(scope.name)).toBeInTheDocument()
    }
  })

  it('labels an empty selection as all projects rather than showing nothing', () => {
    renderPicker()

    expect(screen.getByRole('combobox', { name: 'Projects' })).toHaveTextContent('All projects')
  })

  it('names the one selected scope on the trigger', () => {
    renderPicker({ selectedScopeIds: ['NssfDevOps/dashboards'] })

    expect(screen.getByRole('combobox', { name: 'Projects' })).toHaveTextContent(
      'NssfDevOps / Dashboards'
    )
  })

  it('counts the selection on the trigger once it spans several scopes', () => {
    renderPicker({ selectedScopeIds: ['NssfDevOps/dashboards', 'nssf-dolphin/platform'] })

    expect(screen.getByRole('combobox', { name: 'Projects' })).toHaveTextContent('2 projects')
  })

  it('reports the scope the user picked', async () => {
    const { onScopeIdsChange } = renderPicker()
    const user = await openPicker()

    await user.click(screen.getByRole('option', { name: 'NssfDevOps / Dashboards' }))

    expect(onScopeIdsChange).toHaveBeenCalledWith(['NssfDevOps/dashboards'])
  })

  it('adds a second scope to the selection rather than replacing the first', async () => {
    const { onScopeIdsChange } = renderPicker({ selectedScopeIds: ['NssfDevOps/dashboards'] })
    const user = await openPicker()

    await user.click(screen.getByRole('option', { name: 'nssf-dolphin / Platform' }))

    expect(onScopeIdsChange).toHaveBeenCalledWith([
      'NssfDevOps/dashboards',
      'nssf-dolphin/platform'
    ])
  })

  it('reports an empty selection when the last picked scope is unpicked', async () => {
    const { onScopeIdsChange } = renderPicker({ selectedScopeIds: ['NssfDevOps/dashboards'] })
    const user = await openPicker()

    await user.click(screen.getByRole('option', { name: 'NssfDevOps / Dashboards' }))

    expect(onScopeIdsChange).toHaveBeenCalledWith([])
  })

  it('reports an empty selection when all projects is chosen', async () => {
    const { onScopeIdsChange } = renderPicker({
      selectedScopeIds: ['NssfDevOps/dashboards', 'nssf-dolphin/platform']
    })
    const user = await openPicker()

    await user.click(screen.getByRole('option', { name: 'All projects' }))

    expect(onScopeIdsChange).toHaveBeenCalledWith([])
  })

  it('narrows a long scope list by search', async () => {
    renderPicker()
    const user = await openPicker()

    await user.type(screen.getByPlaceholderText('Search projects...'), 'dashb')

    expect(screen.getByText('NssfDevOps / Dashboards')).toBeInTheDocument()
    expect(screen.queryByText('nssf-dolphin / Platform')).not.toBeInTheDocument()
  })

  it('renders no picker at all for a source that has no scopes', () => {
    renderPicker({ scopes: [] })

    expect(screen.queryByRole('combobox', { name: 'Projects' })).not.toBeInTheDocument()
  })

  it('shows the failure rather than an empty picker when listScopes failed', () => {
    renderPicker({
      scopes: [],
      error: { code: 'forbidden', message: 'No project read access.' }
    })

    expect(screen.getByRole('status')).toHaveTextContent('Projects unavailable')
    expect(screen.queryByRole('combobox', { name: 'Projects' })).not.toBeInTheDocument()
  })
})
