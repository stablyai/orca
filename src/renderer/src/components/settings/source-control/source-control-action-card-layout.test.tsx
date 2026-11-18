// @vitest-environment happy-dom

import { useState } from 'react'

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '../__fixtures__/settings-persistence-test-fixture'
import { useAppStore } from '@/store/index'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type {
  AiActionId,
  SourceControlActionLaunchPreferences
} from '../../../../../shared/source-control/ai/recipes/source-control-ai-actions'

import { resetHostStructuredAgentsForTests } from '@/runtime/native-chat/agent-catalogs/host-structured-agents'
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
const saved = vi.fn()
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
          saved(value, agentArgs)
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
  saved.mockClear()
  resetHostStructuredAgentsForTests()
  useAppStore.setState({ localDetectedAgentIdsByContext: { host: ['claude', 'goose', 'grok'] } })
})
afterEach(resetHostStructuredAgentsForTests)

it('saves chip removals and Arguments from the fields under the recipe picker', async () => {
  configure({ nativeChatProviders: {} })
  render(<Row />)
  const args = () => screen.getByRole('textbox', { name: 'Arguments' })
  await waitFor(() => expect(args()).toHaveProperty('disabled', false))
  expect(args()).toHaveProperty('value', '--saved')
  expect(screen.queryByRole('menu')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Remove --model sonnet' }))
  expect(saved.mock.lastCall?.[0]).toMatchObject({
    agentId: 'claude',
    modelSelection: { model: { agentId: 'claude', value: null } },
    permissionMode: 'full-access'
  })
  expect(screen.queryByRole('button', { name: 'Remove --model sonnet' })).toBeNull()

  fireEvent.change(args(), { target: { value: '--saved --verbose' } })
  fireEvent.blur(args())
  await waitFor(() => expect(saved.mock.lastCall?.[1]).toBe('--saved --verbose'))
  expect(args()).toHaveProperty('value', '--saved --verbose')
})
