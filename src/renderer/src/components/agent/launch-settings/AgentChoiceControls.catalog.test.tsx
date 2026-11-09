// @vitest-environment happy-dom
import {
  act,
  renderHook,
  render,
  fireEvent,
  screen,
  waitFor,
  cleanup
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
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
import { AgentChoiceControls } from './AgentChoiceControls'
import { useAgentModelMenu } from './use-agent-model-menu'
import {
  recordHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from '@/runtime/native-chat/model-catalogs/host-model-catalog-snapshots'
import { modelMenuOptions } from '../../../../../shared/agent-session/options/model-menu-options'
import { getAgentSessionOptionLaunchCatalog } from '../../../../../shared/agent-session/options/agent-session-option-catalog'
const source = {
  scope: { target: { kind: 'local' as const }, agent: 'codex' },
  coherentCatalog: true
}
afterEach(() => {
  cleanup()
  resetHostModelCatalogSnapshotsForTests()
  mocks.call.mockReset()
})

it('clears the saved model through Agent default, without persisting a listed default', () => {
  const change = vi.fn()
  const menu = modelMenuOptions(
    {
      origin: 'probe',
      fetchedAt: 1,
      models: [
        {
          id: 'account-only',
          label: 'Account model',
          isDefault: true,
          efforts: []
        }
      ]
    },
    {
      agent: 'codex',
      seed: getAgentSessionOptionLaunchCatalog('codex')!,
      surface: 'terminal',
      newLaunch: true,
      seedsModel: false,
      saved: { model: 'account-only' }
    }
  )
  render(
    <AgentChoiceControls
      agent="codex"
      value={{ model: 'account-only' }}
      modelMenu={menu}
      onChange={change}
    />
  )
  fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
    target: { value: '__agent_default__' }
  })
  expect(change).toHaveBeenCalledWith({})
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

it('does not read collapsed model menus and shares one read when Settings menus open', async () => {
  const pending = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValue(pending.promise)
  function Row({ open }: { open: boolean }) {
    const menu = useAgentModelMenu('codex', undefined, source, open)
    return <span>{menu.rows.map((row) => row.id).join(',')}</span>
  }
  const view = render(
    <>
      {Array.from({ length: 10 }, (_, i) => (
        <Row key={i} open={false} />
      ))}
    </>
  )
  expect(mocks.call).not.toHaveBeenCalled()
  view.rerender(
    <>
      {Array.from({ length: 10 }, (_, i) => (
        <Row key={i} open />
      ))}
    </>
  )
  await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
  pending.resolve({
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'account-only', label: 'Account model', isDefault: false, efforts: [] }]
  })
  await waitFor(() => expect(screen.getAllByText('account-only')).toHaveLength(10))
})

it('shows fallback only after an eligible settled read fails, never before demand', async () => {
  const pending = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValue(pending.promise)
  const eligible = { ...source, scope: { ...source.scope, worktree: 'id:settings-failure' } }
  function Editor({ applicable }: { applicable: boolean }) {
    const [open, setOpen] = useState(false)
    const menu = useAgentModelMenu('codex', undefined, applicable ? eligible : undefined, open)
    return (
      <AgentChoiceControls
        agent="codex"
        value={undefined}
        modelMenu={menu}
        onChange={() => {}}
        onOpenChange={setOpen}
      />
    )
  }
  const view = render(<Editor applicable={false} />)
  expect(screen.queryByRole('note')).toBeNull()
  expect(mocks.call).not.toHaveBeenCalled()
  view.rerender(<Editor applicable />)
  expect(screen.getByRole('combobox', { name: 'Model' }).getAttribute('aria-busy')).toBe('true')
  expect(screen.queryByRole('note')).toBeNull()
  expect(mocks.call).not.toHaveBeenCalled()
  fireEvent.focus(screen.getByRole('combobox', { name: 'Model' }))
  await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('note')).toBeNull()
  pending.reject(new Error('transport unavailable'))
  await waitFor(() => expect(screen.queryByRole('note')).not.toBeNull())
  view.rerender(<Editor applicable={false} />)
  expect(screen.queryByRole('note')).toBeNull()
})

it.each(['live', 'empty', 'saved-empty'] as const)(
  'keeps successful account %s visible in Settings after self and sibling notifications',
  async (kind) => {
    const saved =
      kind === 'saved-empty' ? { model: 'old-only', options: { effort: 'ultra' } } : undefined
    const change = vi.fn()
    mocks.call.mockResolvedValueOnce({
      origin: 'probe',
      fetchedAt: 3,
      modelsDifferByWorkspace: true,
      listingNamesConfiguredModel: true,
      models:
        kind === 'live'
          ? [
              {
                id: 'gpt-6.1-sol',
                label: 'GPT-6.1 Sol',
                isDefault: true,
                efforts: [
                  { value: 'high', label: 'High' },
                  { value: 'ultra', label: 'Ultra' }
                ],
                defaultEffort: 'high'
              }
            ]
          : []
    })
    const hook = renderHook(() => useAgentModelMenu('codex', saved, source, true))
    await waitFor(() => expect(hook.result.current.status).toBe('listed'))
    expect(hook.result.current.fallbackAfterFailure).toBe(false)
    expect(hook.result.current.rows.map(({ id }) => id)).toEqual(
      kind === 'live' ? ['gpt-6.1-sol'] : []
    )
    for (const worktree of ['id:other', '']) {
      act(() =>
        recordHostModelCatalogSnapshot(source.scope.target, 'codex', worktree, {
          origin: 'probe',
          fetchedAt: 4,
          modelsDifferByWorkspace: true,
          models: [{ id: 'other', label: 'Other', isDefault: false, efforts: [] }]
        })
      )
    }
    expect(hook.result.current.status).toBe('listed')
    expect(hook.result.current.fallbackAfterFailure).toBe(false)
    expect(hook.result.current.rows.map(({ id }) => id)).toEqual(
      kind === 'live' ? ['gpt-6.1-sol'] : []
    )
    render(
      <AgentChoiceControls
        agent="codex"
        value={saved}
        modelMenu={hook.result.current}
        onChange={change}
      />
    )
    const model = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' })
    expect([...model.options].map(({ value }) => value)).toEqual([
      '__agent_default__',
      ...(kind === 'live' ? ['gpt-6.1-sol'] : saved ? ['old-only'] : [])
    ])
    expect(model.value).toBe(saved ? 'old-only' : '__agent_default__')
    expect(screen.queryByRole('note')).toBeNull()
    if (saved) {
      const effort = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Reasoning effort' })
      expect(effort.value).toBe('ultra')
      expect(effort.disabled).toBe(true)
      expect(hook.result.current.descriptors.find(({ id }) => id === 'effort')).toMatchObject({
        settable: false,
        kind: { currentValue: 'ultra' }
      })
      expect(saved).toEqual({ model: 'old-only', options: { effort: 'ultra' } })
    }
    expect(change).not.toHaveBeenCalled()
    hook.unmount()
  }
)
