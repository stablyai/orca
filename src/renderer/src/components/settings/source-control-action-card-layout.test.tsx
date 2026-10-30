// @vitest-environment happy-dom
import { shouldShowSourceControlActionArguments } from './source-control-action-arguments-visibility'
import { useState } from 'react'
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
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
] as const)(
  '%s: keeps launch setup behind the common picker',
  (_name, agent, chat, providers, _visible) => {
    configure({ experimentalNativeChat: chat, nativeChatProviders: providers })
    render(<Row agent={agent} />)
    expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Select agent' })).toBeDefined()
    expect(screen.getByText('Command template')).toBeDefined()
  }
)

it('hides an unresolved launch even with chat off, but always shows text action Arguments', () => {
  configure({ experimentalNativeChat: false })
  useAppStore.setState({ localDetectedAgentIdsByContext: {} })
  const view = render(<Row />)
  expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
  view.rerender(<Row actionId="commitMessage" />)
  expect(screen.getByDisplayValue('--saved')).toBeDefined()
})

it('edits launch arguments in the common setup and keeps the recipe when chat availability changes', async () => {
  configure({ experimentalNativeChat: false })
  render(<Row />)
  const trigger = screen.getByRole('button', { name: 'Select agent' })
  await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
  const input = screen.getByRole('textbox', { name: 'Arguments' })
  expect(input).toHaveProperty('value', '--saved')
  fireEvent.change(input, { target: { value: '--draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  act(() => configure({ experimentalNativeChat: true }))
  expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
  act(() => configure({ experimentalNativeChat: false }))
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('value', '--draft')
  expect(screen.getByRole('button', { name: 'Claude permissions' }).textContent).toContain(
    'Full access'
  )
})

it('reacts to the host registry without adding an inline launch editor', async () => {
  render(<Row agent="grok" />)
  await act(() =>
    loadHostStructuredAgents(
      'local',
      [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY],
      null
    )
  )
  expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Select agent' })).toBeDefined()
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
    expect(controls.getByRole('button', { name: 'Select agent' })).toBeDefined()
    expect(controls.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
    expect(controls.getByText('Command template')).toBeDefined()
    act(() => configure({ experimentalNativeChat: true }))
    expect(controls.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
  }
)

it('isolates equal-baseline row buffers and delegation, retains them on close, and invalidates both on Discard', async () => {
  configure({ experimentalNativeChat: false })
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

it('labels an own raw Sonnet recipe from the same source as its setup chips', async () => {
  configure({
    experimentalNativeChat: false,
    agentPermissionDefault: 'own',
    agentLaunchChoices: { claude: { model: 'claude-opus-5-5' } }
  })
  const recipe = { agentArgs: '--model claude-sonnet-5-5', commandInputTemplate: 'Do the work' }
  render(
    <TooltipProvider>
      <SourceControlActionRecipeRow
        actionId="fixChecks"
        selectedAgent="claude"
        defaultTuiAgent="claude"
        draftValue={recipe}
        baseValue={recipe}
        isSavingTemplate={false}
        onAgentChange={unused}
        onTemplateChange={unused}
        onAgentArgsChange={unused}
        onAppendVariable={unused}
        onDiscard={unused}
        onSave={unused}
      />
    </TooltipProvider>
  )
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Select agent' }).textContent).toMatch(
      /Sonnet|claude-sonnet-5-5/
    )
  )
  expect(screen.getByRole('button', { name: 'Select agent' }).textContent).not.toContain('opus')
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), {
    button: 0,
    ctrlKey: false
  })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Configure Claude' })).toBeDefined()
  )
  fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Remove --model claude-sonnet-5-5' })).toBeDefined()
  )
})
