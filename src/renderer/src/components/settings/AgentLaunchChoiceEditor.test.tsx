// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { AgentLaunchChoiceEditor } from './AgentLaunchChoiceEditor'
import { TooltipProvider } from '../ui/tooltip'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings,
  type AgentLaunchSettingsSource
} from '../../../../shared/agent-launch-settings'
import { resolveAgentPermission } from '../../../../shared/tui-agent-permission-choice'
import { AgentChoiceControls } from './SourceControlActionModelPicker'

vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
)
afterEach(cleanup)

const initial: AgentLaunchSettingsSource = {
  agentPermissionDefault: 'ask',
  agentDefaultArgs: { claude: '--verbose' },
  agentLaunchChoices: { claude: { model: 'opus', options: { effort: 'high' } } }
}
function Fixture({ save }: { save: (mutation: unknown) => Promise<void> }) {
  const [settings, setSettings] = useState(initial)
  const projected = projectAgentLaunchSettings(settings)
  return (
    <TooltipProvider>
      <AgentLaunchChoiceEditor
        agent="claude"
        label="Claude Code"
        choices={settings.agentLaunchChoices?.claude}
        userArgs={projected.agentChoices?.userArgs.claude ?? ''}
        permission={{
          ...resolveAgentPermission('claude', settings),
          choices: ['own', 'ask'],
          defaultChoice: 'ask',
          onSelect: () => {},
          flag: '--permission-mode default',
          argsSetPermission: false
        }}
        save={async (patch, userArgs) => {
          await save({ type: 'launch-choices', agent: 'claude', patch, userArgs })
          setSettings((latest) => ({
            ...latest,
            ...agentLaunchSettingsMutationUpdates(
              latest,
              { type: 'launch-choices', agent: 'claude', patch, userArgs },
              'darwin'
            )
          }))
        }}
      />
    </TooltipProvider>
  )
}

it('removes a choice with dirty conflicting text in one mutation and shares two-Backspace removal', async () => {
  const save = vi.fn(async () => {})
  const view = render(<Fixture save={save} />)
  const input = screen.getByRole('textbox', { name: 'Arguments' })
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error('Missing Arguments textarea')
  }
  fireEvent.change(input, { target: { value: '--model sonnet --verbose' } })
  fireEvent.click(screen.getByRole('button', { name: 'Remove --model opus' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(save).toHaveBeenLastCalledWith({
    type: 'launch-choices',
    agent: 'claude',
    patch: { model: null },
    userArgs: '--model sonnet --verbose'
  })
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Remove --model opus' })).toBeNull()
  )
  expect(input.value).toBe('--model sonnet --verbose')
  fireEvent.change(input, { target: { value: '--permission-mode default --verbose' } })
  input.focus()
  input.setSelectionRange(0, 0)
  fireEvent.keyDown(input, { key: 'Backspace' })
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove --effort high' }))
  expect(save).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(document.activeElement ?? input, { key: 'Backspace' })
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  expect(save).toHaveBeenLastCalledWith({
    type: 'launch-choices',
    agent: 'claude',
    patch: { options: { effort: null } },
    userArgs: '--permission-mode default --verbose'
  })
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Remove --effort high' })).toBeNull()
  )
  expect(input.value).toBe('--verbose')
  fireEvent.change(input, { target: { value: '--permission-mode default --verbose' } })
  input.focus()
  input.setSelectionRange(0, 0)
  fireEvent.keyDown(input, { key: 'Backspace' })
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: /Remove --permission-mode default/ })
  )
  expect(save).toHaveBeenCalledTimes(2)
  fireEvent.keyDown(document.activeElement ?? input, { key: 'Backspace' })
  await waitFor(() => expect(save).toHaveBeenCalledTimes(3))
  expect(save).toHaveBeenLastCalledWith({
    type: 'launch-choices',
    agent: 'claude',
    patch: { permissionMode: 'own' },
    userArgs: '--permission-mode default --verbose'
  })
  await waitFor(() => expect(input.value).toBe('--verbose'))
  const props = { agent: 'claude' as const, layout: 'rows' as const, onChange: vi.fn() }
  view.rerender(<AgentChoiceControls {...props} value={{}} />)
  expect(
    screen.getByRole('button', { name: 'Model: Agent default' }).hasAttribute('disabled')
  ).toBe(false)
  expect(screen.getByRole('button', { name: 'Effort: Default' })).toBeTruthy()
  view.rerender(
    <AgentChoiceControls
      {...props}
      value={{ model: 'opus', options: { effort: 'high' } }}
      disabled
    />
  )
  expect(screen.getByRole('button', { name: 'Model: Opus' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Effort: High' }).hasAttribute('disabled')).toBe(true)
})

it('keeps the dirty text and badge after a failed coupled save', async () => {
  const save = vi.fn(async () => {
    throw new Error('disk full')
  })
  render(<Fixture save={save} />)
  const input = screen.getByRole('textbox', { name: 'Arguments' })
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error('Missing Arguments textarea')
  }
  fireEvent.change(input, { target: { value: '--model opus --verbose retry' } })
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Remove --model opus' }))
  )
  expect(save).toHaveBeenCalledTimes(1)
  expect(input.value).toBe('--model opus --verbose retry')
  expect(screen.getByRole('button', { name: 'Remove --model opus' }).hasAttribute('disabled')).toBe(
    false
  )
})

it('saves a dirty Arguments edit with a menu choice once, and shares pending state with Reset', async () => {
  const save = vi.fn(async () => {})
  render(<Fixture save={save} />)
  const input = screen.getByRole('textbox', { name: 'Arguments' })
  fireEvent.change(input, { target: { value: '--model sonnet --verbose changed' } })
  input.focus()
  await userEvent.click(screen.getByRole('button', { name: 'Model: Opus' }))
  expect(save).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'Haiku' }))
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(save).toHaveBeenCalledWith({
    type: 'launch-choices',
    agent: 'claude',
    patch: { model: 'haiku' },
    userArgs: '--model sonnet --verbose changed'
  })
  await waitFor(() => expect(input).toHaveProperty('value', '--verbose changed'))
  const pending = Promise.withResolvers<void>()
  save.mockImplementationOnce(() => pending.promise)
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
  expect(save).toHaveBeenCalledTimes(2)
  expect(save).toHaveBeenLastCalledWith({
    type: 'launch-choices',
    agent: 'claude',
    patch: undefined,
    userArgs: ''
  })
  expect(screen.getByRole('button', { name: 'Model: Haiku' }).hasAttribute('disabled')).toBe(true)
  await act(async () => pending.resolve())
  await waitFor(() => expect(input).toHaveProperty('value', ''))
})

it.each([
  ['Opus', '--model sonnet --verbose', { model: 'opus' }],
  ['High', '--effort low --verbose', { options: { effort: 'high' } }]
] as const)(
  'retains the actual checked %s operation against dirty opposing raw',
  async (label, raw, patch) => {
    const save = vi.fn(async () => {})
    render(<Fixture save={save} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), { target: { value: raw } })
    await userEvent.click(
      screen.getByRole('button', { name: `${label === 'Opus' ? 'Model' : 'Effort'}: ${label}` })
    )
    await userEvent.click(screen.getByRole('menuitemradio', { name: label }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save).toHaveBeenCalledWith({
      type: 'launch-choices',
      agent: 'claude',
      patch,
      userArgs: raw
    })
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty(
        'value',
        '--verbose'
      )
    )
  }
)

it('commits on focus-only outer exit before unmount, without opening a menu', async () => {
  const save = vi.fn(async () => {})
  const mounted = render(
    <>
      <Fixture save={save} />
      <button>Outside</button>
    </>
  )
  const input = screen.getByRole('textbox', { name: 'Arguments' })
  fireEvent.change(input, { target: { value: '--verbose changed' } })
  input.focus()
  await userEvent.tab({ shift: true })
  expect(save).not.toHaveBeenCalled()
  screen.getByRole('button', { name: 'Outside' }).focus()
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  mounted.unmount()
  expect(save).toHaveBeenCalledWith({
    type: 'launch-choices',
    agent: 'claude',
    patch: undefined,
    userArgs: '--verbose changed'
  })
})
