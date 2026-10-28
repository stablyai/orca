// @vitest-environment happy-dom
import { useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import './__fixtures__/settings-persistence-test-fixture'
import { useAppStore } from '@/store'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type {
  AiActionId,
  SourceControlActionLaunchPreferences
} from '../../../../shared/source-control-ai-actions'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  loadHostStructuredAgents,
  resetHostStructuredAgentsForTests
} from '@/runtime/host-structured-agents'
import { TooltipProvider } from '../ui/tooltip'
import { SourceControlActionRecipeRow } from './SourceControlActionRecipeRow'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => ({ agents: [{ agent: 'grok', capabilities: {} }] }))
}))
const unused = vi.fn()
function configure(patch: Partial<GlobalSettings>) {
  useAppStore.setState(({ settings }) => ({ settings: settings && { ...settings, ...patch } }))
}
function Row({
  agent = 'claude',
  actionId = 'fixChecks'
}: {
  agent?: TuiAgent
  actionId?: AiActionId
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
        launchPreferences={preferences}
        onLaunchPreferencesChange={(_id, value) => setPreferences(value)}
        onAgentArgsChange={(_id, agentArgs) => setDraft({ ...draft, agentArgs })}
        onAgentChange={unused}
        onTemplateChange={unused}
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

it('keeps the draft and chip while Model/Effort controls stay hidden', () => {
  configure({ experimentalNativeChat: false })
  render(<Row />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
    target: { value: '--draft' }
  })
  act(() => configure({ experimentalNativeChat: true }))
  expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Claude permissions' }).textContent).toContain(
    'Full access'
  )
  expect(screen.getByRole('button', { name: 'Claude permissions' }).getAttribute('data-size')).toBe(
    'sm'
  )
  act(() => configure({ experimentalNativeChat: false }))
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('value', '--draft')
  expect(
    screen.getByRole('button', { name: /Remove --dangerously-skip-permissions/ })
  ).toBeDefined()
  expect(screen.queryByRole('combobox', { name: 'Sonnet' })).toBeNull()
  expect(screen.queryByRole('combobox', { name: 'High' })).toBeNull()
  expect(unused).not.toHaveBeenCalled()
})

it('reacts to the real host registry when another agent gains chat support', async () => {
  render(<Row agent="grok" />)
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toBeDefined()
  await act(() =>
    loadHostStructuredAgents(
      'local',
      [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY],
      null
    )
  )
  expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
})
