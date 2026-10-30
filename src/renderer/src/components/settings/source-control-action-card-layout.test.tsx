// @vitest-environment happy-dom
import { shouldShowSourceControlActionArguments } from './source-control-action-arguments-visibility'
import { useState } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
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
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../shared/source-control-ai'
import { RepositorySourceControlAiActionRows } from './repository/source-control/RepositorySourceControlAiActionRows'
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

it.each([
  ['chat on', 'claude', true, undefined, false],
  ['chat off', 'claude', false, undefined, true],
  ['provider off', 'claude', true, { claude: false }, true],
  ['no chat support', 'goose', true, undefined, true]
] as const)('%s: shows Arguments only for the CLI', (_name, agent, chat, providers, visible) => {
  configure({ experimentalNativeChat: chat, nativeChatProviders: providers })
  render(<Row agent={agent} />)
  expect(Boolean(screen.queryByRole('textbox', { name: 'Arguments' }))).toBe(visible)
  expect(screen.getByText('Command template')).toBeDefined()
})

it('hides an unresolved launch even with chat off, but always shows text action Arguments', () => {
  configure({ experimentalNativeChat: false })
  useAppStore.setState({ localDetectedAgentIdsByContext: {} })
  const view = render(<Row />)
  expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
  view.rerender(<Row actionId="commitMessage" />)
  expect(screen.getByDisplayValue('--saved')).toBeDefined()
})

it('keeps the draft while Arguments hide and renders the model and effort beside Permissions', () => {
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
  expect(screen.getByRole('combobox', { name: 'Sonnet' })).toBeDefined()
  expect(screen.getByRole('combobox', { name: 'High' })).toBeDefined()
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

it('honors an explicit future surface only after an agent resolves', () => {
  const input = {
    agent: 'claude',
    settings: { experimentalNativeChat: true },
    chatAgents: ['claude']
  } as const
  expect(shouldShowSourceControlActionArguments({ ...input, launchKind: 'terminal' })).toBe(true)
  expect(
    shouldShowSourceControlActionArguments({
      ...input,
      settings: { experimentalNativeChat: false },
      launchKind: 'chat'
    })
  ).toBe(false)
  expect(
    shouldShowSourceControlActionArguments({ ...input, agent: null, launchKind: 'terminal' })
  ).toBe(false)
})

it.each(['', null, '--verbose', undefined])(
  'repository Args %s uses the shared controls, source and wrapping layout',
  (agentArgs) => {
    configure({ experimentalNativeChat: false })
    useAppStore.setState({
      repos: [{ id: 'repo', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }]
    })
    const source = normalizeSourceControlAiSettings({
      ...getDefaultSourceControlAiSettings(),
      actions: {
        fixChecks: {
          agentId: 'claude',
          launchPreferences: { agentId: 'claude', model: 'sonnet', options: { effort: 'high' } }
        }
      }
    })
    const repoAi: RepoSourceControlAiOverrides = {
      actionOverrides: {
        fixChecks: {
          commandInputTemplate: 'mine',
          ...(agentArgs !== undefined ? { agentArgs } : {})
        }
      }
    }
    render(
      <TooltipProvider>
        <RepositorySourceControlAiActionRows
          repoId="repo"
          repoAi={repoAi}
          source={source}
          defaultTuiAgent="claude"
          onActionModeChange={unused}
          onActionAgentChange={unused}
          onActionLaunchPreferencesChange={unused}
          onActionTemplateChange={unused}
          onActionAgentArgsChange={unused}
          onAppendVariable={unused}
          savingActionIds={{}}
          actionDirtyById={{
            commitMessage: false,
            pullRequest: false,
            branchName: false,
            fixCommitFailure: false,
            fixPushFailure: false,
            fixChecks: false,
            resolveConflicts: false,
            resolveComments: false
          }}
          onActionDiscard={unused}
          onActionSave={unused}
        />
      </TooltipProvider>
    )
    const card = screen.getByText('Broken checks fixes').closest('[data-settings-section]')
    if (!(card instanceof HTMLElement)) {
      throw new Error('Missing action card')
    }
    const controls = within(card)
    const model = controls.getByRole('combobox', {
      name: agentArgs === undefined ? 'Sonnet' : 'Agent default'
    })
    expect(
      controls.getByRole('combobox', { name: agentArgs === undefined ? 'High' : 'Default' })
    ).toBeDefined()
    expect(
      controls.getByText(
        agentArgs === undefined
          ? 'Global custom args'
          : agentArgs
            ? 'Repository custom args'
            : 'No args'
      )
    ).toBeDefined()
    const row = model.closest('.flex-wrap')
    expect(row?.contains(controls.getByRole('button', { name: 'Claude permissions' }))).toBe(true)
    const input = controls.getByRole('textbox', { name: 'Arguments' })
    expect(row?.querySelector(':scope > .w-full')?.contains(input)).toBe(true)
    expect(row?.parentElement?.className).toContain('grid-cols-1')
    expect(
      row?.parentElement?.lastElementChild?.contains(controls.getByText('Command template'))
    ).toBe(true)
    expect(Boolean(controls.queryByRole('button', { name: 'Remove --model sonnet' }))).toBe(
      agentArgs === undefined
    )
    act(() => configure({ experimentalNativeChat: true }))
    expect(controls.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
    expect(
      controls.getByRole('combobox', { name: agentArgs === undefined ? 'Sonnet' : 'Agent default' })
    ).toBeDefined()
    act(() => configure({ experimentalNativeChat: false }))
    expect(controls.getByRole('textbox', { name: 'Arguments' })).toHaveProperty(
      'value',
      agentArgs ?? ''
    )
  }
)
