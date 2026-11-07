// @vitest-environment happy-dom

import { useState } from 'react'

import { fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../__fixtures__/settings-persistence-test-fixture'
import { useAppStore } from '@/store/index'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type {
  AiActionId,
  SourceControlActionLaunchPreferences
} from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'

import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import { TooltipProvider } from '../../ui/tooltip'

import { SourceControlActionRecipeRow } from './SourceControlActionRecipeRow'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn(async (_target, method) =>
    method === 'agentSession.modelCatalog'
      ? { origin: 'unknown' }
      : { agents: [{ agent: 'grok', capabilities: {} }] }
  )
}))
const unused = vi.fn()
function configure(patch: Partial<GlobalSettings>) {
  useAppStore.setState(({ settings }) => ({ settings: settings && { ...settings, ...patch } }))
}
function Row({
  agent = 'claude',
  actionId = 'fixChecks',
  dirty = false
}: {
  agent?: TuiAgent
  actionId?: AiActionId
  dirty?: boolean
}) {
  const [draft, setDraft] = useState({ agentArgs: '--saved', commandInputTemplate: 'Do the work' })
  const [preferences, setPreferences] = useState<SourceControlActionLaunchPreferences | undefined>({
    agentId: 'claude',
    model: 'sonnet',
    options: { effort: 'high' },
    permissionMode: 'full-access'
  })
  return (
    <TooltipProvider>
      <SourceControlActionRecipeRow
        actionId={actionId}
        selectedAgent={agent}
        defaultTuiAgent="claude"
        draftValue={draft}
        baseValue={draft}
        isSavingTemplate={false}
        hasUnsavedChanges={dirty}
        launchPreferences={preferences}
        onLaunchPreferencesChange={(_id, value, agentArgs) => {
          setPreferences(value)
          if (agentArgs !== undefined) {
            setDraft({ ...draft, agentArgs })
          }
        }}
        onAgentArgsChange={(_id, agentArgs) => setDraft({ ...draft, agentArgs })}
        onAgentChange={unused}
        onTemplateChange={(_id, commandInputTemplate) =>
          setDraft((draft) => ({ ...draft, commandInputTemplate }))
        }
        onAppendVariable={unused}
        onDiscard={unused}
        onSave={unused}
      />
    </TooltipProvider>
  )
}
beforeEach(() => {
  resetHostStructuredAgentsForTests()
  useAppStore.setState({ localDetectedAgentIdsByContext: { host: ['claude', 'goose', 'grok'] } })
})
afterEach(resetHostStructuredAgentsForTests)

it('isolates equal-baseline row buffers and delegation, retains them on close, and invalidates both on Discard', async () => {
  configure({ nativeChatProviders: {} })
  render(
    <>
      <div data-testid="first-row">
        <Row dirty />
      </div>
      <div data-testid="second-row">
        <Row dirty />
      </div>
    </>
  )
  const first = within(screen.getByTestId('first-row'))
  const second = within(screen.getByTestId('second-row'))
  const open = async (row: typeof first) => {
    const trigger = row.getByRole('button', { name: 'Select agent' })
    await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('disabled', false)
    )
  }
  const close = () => {
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Arguments' }), { key: 'Escape' })
    expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
  }
  await open(first)
  fireEvent.click(screen.getByRole('button', { name: 'Remove --model sonnet' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
    target: { value: '--unaccepted' }
  })
  close()
  await open(second)
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('value', '--saved')
  expect(screen.getByRole('button', { name: 'Remove --model sonnet' })).toBeDefined()
  close()
  await open(first)
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('value', '--unaccepted')
  expect(screen.queryByRole('button', { name: 'Remove --model sonnet' })).toBeNull()
  close()
  fireEvent.click(first.getByRole('button', { name: 'Discard' }))
  await open(first)
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('value', '--saved')
  expect(screen.getByRole('button', { name: 'Remove --model sonnet' })).toBeDefined()
})

it('keeps the complete staged global setup across a template-only edit and applies Use onto the current card', async () => {
  configure({ nativeChatProviders: {} })
  render(<Row />)
  const trigger = screen.getByRole('button', { name: 'Select agent' })
  const open = async () => {
    await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
  }
  await open()
  fireEvent.click(screen.getByRole('button', { name: 'Remove --model sonnet' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
    target: { value: '--latest-pending' }
  })
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Arguments' }), { key: 'Escape' })
  fireEvent.keyDown(document, { key: 'Escape' })
  const template = screen.getByDisplayValue('Do the work')
  fireEvent.change(template, { target: { value: 'New unrelated template' } })
  await open()
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty(
    'value',
    '--latest-pending'
  )
  expect(screen.queryByRole('button', { name: 'Remove --model sonnet' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }))
  expect(template).toHaveProperty('value', 'New unrelated template')
  await open()
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty(
    'value',
    '--latest-pending'
  )
})
