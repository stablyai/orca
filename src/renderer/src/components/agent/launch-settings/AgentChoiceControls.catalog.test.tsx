// @vitest-environment happy-dom
import { act, render, fireEvent, screen, waitFor, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../shared/constants'
import { AgentChoiceControls } from './AgentChoiceControls'
import type { AgentDedicatedChoices } from '../../../../../shared/agent-launch/choices/agent-launch-choices'
const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('./AgentChoiceMenu', () => ({
  AgentChoiceMenu: (props: {
    label: string
    value: string
    choices: { value: string; label: string }[]
    disabled?: boolean
    pendingLabel?: string
    onChange: (value: string) => void
    onOpenChange?: (open: boolean) => void
  }) => (
    <select
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      aria-busy={props.pendingLabel !== undefined}
      onFocus={() => props.onOpenChange?.(true)}
      onChange={(event) => props.onChange(event.target.value)}
    >
      {props.choices.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.label}
        </option>
      ))}
    </select>
  )
}))

import { HostAgentLaunchChoiceEditor } from '@/components/settings/agents/launch/HostAgentLaunchChoiceEditor'
import { useAgentModelMenu } from './use-agent-model-menu'
import {
  recordHostModelCatalogSnapshot,
  readHostModelCatalogSnapshot,
  preloadHostModelCatalogSnapshots,
  resetHostModelCatalogSnapshotsForTests
} from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import { modelMenuOptions } from '../../../../../shared/agent-session/options/model-menu-options'
import { getAgentSessionOptionLaunchCatalog } from '../../../../../shared/agent-session/options/agent-session-option-catalog'
const initialStore = useAppStore.getState()
const source = {
  scope: { target: { kind: 'local' as const }, agent: 'codex' },
  coherentCatalog: true
}
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  resetHostModelCatalogSnapshotsForTests()
  mocks.call.mockReset()
})

it('keeps options-only effort editable through pinning and clearing the model', () => {
  const changed = vi.fn()
  function Editor() {
    const [value, setValue] = useState<AgentDedicatedChoices | undefined>({
      options: { effort: 'high' }
    })
    const menu = modelMenuOptions(
      {
        origin: 'probe',
        fetchedAt: 1,
        models: [
          {
            id: 'account-only',
            label: 'Account',
            isDefault: false,
            efforts: [
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' }
            ]
          }
        ]
      },
      {
        agent: 'codex',
        seed: getAgentSessionOptionLaunchCatalog('codex')!,
        surface: 'terminal',
        newLaunch: true,
        seedsModel: false,
        saved: { ...(value?.model ? { model: value.model } : {}), ...value?.options }
      }
    )
    return (
      <AgentChoiceControls
        agent="codex"
        value={value}
        modelMenu={menu}
        onChange={(next) => {
          changed(next)
          setValue(next)
        }}
      />
    )
  }
  render(<Editor />)
  const effort = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Reasoning effort' })
  expect(effort().value).toBe('high')
  fireEvent.change(effort(), { target: { value: 'medium' } })
  expect(changed).toHaveBeenLastCalledWith({ options: { effort: 'medium' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
    target: { value: 'account-only' }
  })
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
    target: { value: '__agent_default__' }
  })
  expect(effort().value).toBe('medium')
  expect(changed).toHaveBeenLastCalledWith({ options: { effort: 'medium' } })
  fireEvent.change(effort(), { target: { value: '__agent_default__' } })
  expect(changed).toHaveBeenLastCalledWith({})
})

it('keeps its own account rows and mounted saved label independent of preload and workspace seeds', async () => {
  useAppStore.setState({ settings: getDefaultSettings('/synthetic') })
  const preload = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValueOnce(preload.promise).mockResolvedValueOnce({
    origin: 'probe',
    fetchedAt: 3,
    modelsDifferByWorkspace: true,
    listingNamesConfiguredModel: true,
    models: [
      {
        id: 'gpt-6-luna',
        label: 'GPT-6 Luna',
        isDefault: true,
        defaultEffort: 'high',
        efforts: [
          { value: 'high', label: 'High' },
          { value: 'ultra', label: 'Ultra' }
        ]
      }
    ]
  })
  const preloading = preloadHostModelCatalogSnapshots(source.scope.target, ['codex'], {
    savedOnly: true
  })
  recordHostModelCatalogSnapshot(source.scope.target, 'codex', 'id:composer', {
    origin: 'probe',
    fetchedAt: 2,
    modelsDifferByWorkspace: true,
    models: [{ id: 'composer-only', label: 'Composer', isDefault: false, efforts: [] }]
  })
  function Editor({ open, saved }: { open: boolean; saved?: AgentDedicatedChoices }) {
    const menu = useAgentModelMenu('codex', saved, source, open)
    return <AgentChoiceControls agent="codex" value={saved} modelMenu={menu} onChange={() => {}} />
  }
  const view = render(<Editor open />)
  await waitFor(() => expect(screen.getByRole('option', { name: 'GPT-6 Luna' })).toBeTruthy())
  await act(async () => {
    preload.resolve({
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'preload-only', label: 'Preload', isDefault: false, efforts: [] }]
    })
    await preloading
    recordHostModelCatalogSnapshot(source.scope.target, 'codex', 'id:sibling', {
      origin: 'probe',
      fetchedAt: 4,
      modelsDifferByWorkspace: true,
      models: [{ id: 'sibling-only', label: 'Sibling', isDefault: false, efforts: [] }]
    })
  })
  expect(
    readHostModelCatalogSnapshot(source.scope.target, 'codex', {
      worktree: 'id:composer',
      newLaunch: true,
      seedsModel: true
    })
  ).toMatchObject({ models: [{ id: 'composer-only' }] })
  expect(
    [...screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' }).options].map(
      ({ value }) => value
    )
  ).toEqual(['__agent_default__', 'gpt-6-luna'])
  expect(screen.queryByRole('note')).toBeNull()
  view.rerender(
    <Editor open={false} saved={{ model: 'gpt-6-luna', options: { effort: 'ultra' } }} />
  )
  const model = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' })
  act(() =>
    useAppStore.setState((state) => ({
      settings: {
        ...state.settings!,
        agentCmdOverrides: { ...state.settings?.agentCmdOverrides },
        nativeChatSessionOptions: { codex: { model: 'gpt-6-luna' } }
      }
    }))
  )
  expect(model.selectedOptions[0].label).toBe('GPT-6 Luna')
  expect(model.getAttribute('aria-busy')).toBe('false')
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Reasoning effort' }).value).toBe(
    'ultra'
  )
})

it('keeps the Settings fallback for an assignment-prefixed terminal wrapper', async () => {
  const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { platform: { get: () => ({ platform: 'darwin' }) } }
  })
  mocks.call.mockResolvedValue({
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'wrong-account', label: 'Wrong account', isDefault: false, efforts: [] }]
  })
  try {
    render(
      <HostAgentLaunchChoiceEditor
        agent="codex"
        label="Codex"
        choices={undefined}
        userArgs=""
        permission={undefined}
        save={async () => {}}
        detectionTarget={{ kind: 'local' }}
        commandOverride="ACCOUNT=other codex"
        showArguments={false}
      />
    )
    await act(async () => {
      fireEvent.focus(screen.getByRole('combobox', { name: 'Model' }))
    })
    expect(
      [...screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' }).options].map(
        ({ value }) => value
      )
    ).toContain('gpt-5.6-sol')
    expect(screen.queryByRole('option', { name: 'Wrong account' })).toBeNull()
  } finally {
    if (previousApi) {
      Object.defineProperty(window, 'api', previousApi)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
  }
})
