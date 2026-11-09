// @vitest-environment happy-dom
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
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
    onChange: (value: string) => void
    onOpenChange?: (open: boolean) => void
  }) => (
    <select
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
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
import { modelMenuOptions } from '../../../../../shared/agent-session/options/model-menu-options'
import { getAgentSessionOptionLaunchCatalog } from '../../../../../shared/agent-session/options/agent-session-option-catalog'
const source = {
  scope: { target: { kind: 'local' as const }, agent: 'codex' },
  coherentCatalog: true
}
afterEach(() => {
  cleanup()
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
