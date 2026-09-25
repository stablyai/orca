// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  PluginTaskItem,
  PluginTaskItemType,
  PluginTaskScope,
  PluginTaskSourceResult
} from '../../../../../shared/plugins/plugin-task-source-contract'
import { TaskPagePluginSourceCreateButton } from './CreateItemDialog'

afterEach(cleanup)

const SCOPES: PluginTaskScope[] = [
  { id: 'FabrikamOps/dashboards', name: 'FabrikamOps / Dashboards' },
  { id: 'contoso-labs/platform', name: 'contoso-labs / Platform' }
]

const TYPES_BY_SCOPE: Record<string, PluginTaskItemType[]> = {
  'FabrikamOps/dashboards': [
    { id: 'Bug', name: 'Bug' },
    { id: 'Task', name: 'Task' }
  ],
  'contoso-labs/platform': [{ id: 'Epic', name: 'Epic' }]
}

function createdItem(): PluginTaskItem {
  return {
    id: '2488',
    key: '2488',
    title: 'Ship the create dialog',
    state: { name: 'To Do', category: 'todo' },
    assignee: null,
    url: null,
    updatedAt: null,
    scopeId: 'FabrikamOps/dashboards'
  }
}

function renderButton(
  props: {
    selectedScopeIds?: string[]
    listItemTypes?: (scopeId: string) => Promise<PluginTaskSourceResult<PluginTaskItemType[]>>
    createItem?: () => Promise<PluginTaskSourceResult<PluginTaskItem>>
    onCreated?: () => void
  } = {}
): void {
  render(
    <TooltipProvider>
      <TaskPagePluginSourceCreateButton
        scopes={SCOPES}
        selectedScopeIds={props.selectedScopeIds ?? ['FabrikamOps/dashboards']}
        listItemTypes={
          props.listItemTypes ??
          (async (scopeId) => ({ ok: true, data: TYPES_BY_SCOPE[scopeId] ?? [] }))
        }
        createItem={props.createItem ?? (async () => ({ ok: true, data: createdItem() }))}
        onCreated={props.onCreated ?? vi.fn()}
      />
    </TooltipProvider>
  )
}

async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'New task' }))
}

async function pickOption(
  user: ReturnType<typeof userEvent.setup>,
  field: string,
  option: string
): Promise<void> {
  await user.click(await screen.findByRole('combobox', { name: field }))
  await user.click(await screen.findByRole('option', { name: option }))
}

describe('TaskPage contributed source create dialog', () => {
  it('defaults the project to the one selected scope', async () => {
    const user = userEvent.setup()
    renderButton({ selectedScopeIds: ['contoso-labs/platform'] })

    await openDialog(user)

    expect(await screen.findByRole('combobox', { name: 'Project' })).toHaveTextContent(
      'contoso-labs / Platform'
    )
    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Type' })).toBeEnabled()
    })
  })

  it('preselects no project and blocks submit when every scope is in view', async () => {
    const user = userEvent.setup()
    renderButton({ selectedScopeIds: [] })

    await openDialog(user)

    expect(await screen.findByRole('combobox', { name: 'Project' })).toHaveTextContent(
      'Select a project'
    )
    await user.type(screen.getByLabelText('Title'), 'Ship the create dialog')
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it('preselects no project and blocks submit when several scopes are selected', async () => {
    const user = userEvent.setup()
    renderButton({ selectedScopeIds: SCOPES.map((scope) => scope.id) })

    await openDialog(user)

    expect(await screen.findByRole('combobox', { name: 'Project' })).toHaveTextContent(
      'Select a project'
    )
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  it('refetches types for a newly picked project and drops the previous project types', async () => {
    const user = userEvent.setup()
    let releaseSecond = (): void => {}
    const secondCall = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    const listItemTypes = vi.fn(async (scopeId: string) => {
      if (scopeId === 'contoso-labs/platform') {
        await secondCall
      }
      return { ok: true as const, data: TYPES_BY_SCOPE[scopeId] ?? [] }
    })
    renderButton({ listItemTypes })

    await openDialog(user)
    await pickOption(user, 'Type', 'Bug')
    expect(screen.getByRole('combobox', { name: 'Type' })).toHaveTextContent('Bug')

    await pickOption(user, 'Project', 'contoso-labs / Platform')

    const typeField = screen.getByRole('combobox', { name: 'Type' })
    expect(typeField).toBeDisabled()
    expect(typeField).not.toHaveTextContent('Bug')

    releaseSecond()
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Type' })).toBeEnabled())

    await user.click(screen.getByRole('combobox', { name: 'Type' }))
    expect(await screen.findByRole('option', { name: 'Epic' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: 'Bug' })).not.toBeInTheDocument()
    expect(listItemTypes).toHaveBeenCalledTimes(2)
  })

  it('creates with the chosen project, type, title and description', async () => {
    const user = userEvent.setup()
    const createItem = vi.fn().mockResolvedValue({ ok: true, data: createdItem() })
    renderButton({ createItem })

    await openDialog(user)
    await pickOption(user, 'Type', 'Task')
    await user.type(screen.getByLabelText('Title'), 'Ship the create dialog')
    await user.type(screen.getByLabelText('Description (optional)'), 'With a real type list.')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(createItem).toHaveBeenCalledWith({
        scopeId: 'FabrikamOps/dashboards',
        typeId: 'Task',
        title: 'Ship the create dialog',
        description: 'With a real type list.'
      })
    })
  })

  it('closes the dialog and refreshes the list after a successful create', async () => {
    const user = userEvent.setup()
    const onCreated = vi.fn()
    renderButton({ onCreated })

    await openDialog(user)
    await pickOption(user, 'Type', 'Bug')
    await user.type(screen.getByLabelText('Title'), 'Ship the create dialog')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByLabelText('Title')).not.toBeInTheDocument())
  })

  it('reports a failed create and keeps the entered title', async () => {
    const user = userEvent.setup()
    const createItem = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'forbidden', message: 'Board token expired.' })
    renderButton({ createItem })

    await openDialog(user)
    await pickOption(user, 'Type', 'Bug')
    await user.type(screen.getByLabelText('Title'), 'Ship the create dialog')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Board token expired.')
    expect(screen.getByLabelText('Title')).toHaveValue('Ship the create dialog')
  })

  it('does not fire a second create while one is in flight', async () => {
    const user = userEvent.setup()
    let release = (): void => {}
    const inFlightCreate = new Promise<void>((resolve) => {
      release = resolve
    })
    const createItem = vi.fn(async () => {
      await inFlightCreate
      return { ok: true as const, data: createdItem() }
    })
    renderButton({ createItem })

    await openDialog(user)
    await pickOption(user, 'Type', 'Bug')
    await user.type(screen.getByLabelText('Title'), 'Ship the create dialog')

    const submit = screen.getByRole('button', { name: 'Create' })
    await user.click(submit)
    await user.click(screen.getByRole('button', { name: 'Creating...' }))

    expect(createItem).toHaveBeenCalledTimes(1)
    release()
    await waitFor(() => expect(screen.queryByLabelText('Title')).not.toBeInTheDocument())
  })
})
