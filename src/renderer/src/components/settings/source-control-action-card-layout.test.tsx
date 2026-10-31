import type * as MenuObservation from '../tab-bar/use-new-tab-agent-menu-rows'
import type * as PickerModule from '../agent/AgentLaunchPicker'
import { RepositorySourceControlAiSection } from './repository/source-control/RepositorySourceControlAiSection'
import { SourceControlAiActionRecipeDefaults } from './SourceControlAiActionRecipeDefaults'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
// @vitest-environment happy-dom
import { shouldShowSourceControlActionArguments } from './source-control-action-arguments-visibility'
import { useState } from 'react'
import * as sourceProjection from './source-control-agent-launch-picker'
import * as choiceAnalysis from '../../../../shared/agent-choice-args'
import * as pickerCatalog from '../../../../shared/agent-session-option-catalog'
import * as reconciliation from '../../../../shared/agent-choice-reconciliation'
import * as launchProfile from '../../../../shared/agent-launch-profile'
import { SourceControlActionAgentPicker } from './SourceControlActionAgentPicker'
import { canonicalSourceControlActionSelection } from '../../../../shared/source-control-action-selection'
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
  retainHostStructuredAgents,
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
const renderWork = vi.hoisted(() => ({ observers: vi.fn(), consumers: vi.fn() }))
vi.mock('../tab-bar/use-new-tab-agent-menu-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof MenuObservation>()
  return {
    ...actual,
    useAgentMenuObservation: (...args: Parameters<typeof actual.useAgentMenuObservation>) => {
      renderWork.observers()
      return actual.useAgentMenuObservation(...args)
    }
  }
})
vi.mock('@/components/agent/AgentLaunchPicker', async (importOriginal) => {
  const actual = await importOriginal<typeof PickerModule>()
  return {
    ...actual,
    AgentLaunchPicker: (props: React.ComponentProps<typeof actual.AgentLaunchPicker>) => {
      renderWork.consumers()
      return <actual.AgentLaunchPicker {...props} />
    }
  }
})
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

it.each([
  ['chat on', 'claude', { claude: true }],
  ['no saved choice', 'claude', undefined],
  ['provider off', 'claude', { claude: false }],
  ['no chat support', 'goose', { goose: true }]
] as const)('%s: keeps launch setup behind the common picker', (_name, agent, providers) => {
  configure({ nativeChatProviders: providers })
  render(<Row agent={agent} />)
  expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Select agent' })).toBeDefined()
  expect(screen.getByText('Command template')).toBeDefined()
})

it('hides an unresolved launch even with chat off, but always shows text action Arguments', () => {
  configure({ nativeChatProviders: {} })
  useAppStore.setState({ localDetectedAgentIdsByContext: {} })
  const view = render(<Row />)
  expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
  view.rerender(<Row actionId="commitMessage" />)
  expect(screen.getByDisplayValue('--saved')).toBeDefined()
})

it('edits launch arguments in the common setup and keeps the recipe when chat availability changes', async () => {
  configure({ nativeChatProviders: {} })
  render(<Row />)
  const trigger = screen.getByRole('button', { name: 'Select agent' })
  await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
  const input = screen.getByRole('textbox', { name: 'Arguments' })
  expect(input).toHaveProperty('value', '--saved')
  fireEvent.change(input, { target: { value: '--draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  act(() => configure({ nativeChatProviders: { claude: true } }))
  expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
  act(() => configure({ nativeChatProviders: {} }))
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
    settings: { nativeChatProviders: { claude: true } },
    chatAgents: ['claude']
  } as const
  expect(shouldShowSourceControlActionArguments({ ...input, launchKind: 'terminal' })).toBe(true)
  expect(
    shouldShowSourceControlActionArguments({
      ...input,
      settings: { nativeChatProviders: {} },
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
    configure({ nativeChatProviders: {} })
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
    act(() => configure({ nativeChatProviders: { claude: true } }))
    expect(controls.queryByRole('textbox', { name: 'Arguments' })).toBeNull()
  }
)

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

it('labels an own raw Sonnet recipe from the same source as its setup chips', async () => {
  configure({
    nativeChatProviders: {},
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
  const { projectSourceControlActionLaunch } =
    await import('../../../../shared/source-control-action-launch-preferences')
  const { resolveAgentStartupPlanInputs } =
    await import('../../../../shared/agent-startup-plan-inputs')
  const { buildAgentStartupPlan } = await import('../../../../shared/tui-agent-startup')
  const settings = useAppStore.getState().settings
  const projection = projectSourceControlActionLaunch(recipe, 'claude', {
    basePrompt: 'Do the work',
    settings
  })
  const startup = buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({
      agent: 'claude',
      settings,
      agentArgs: projection.agentArgs,
      sessionOptions: projection.sessionOptions,
      platform: 'linux',
      shell: 'posix',
      isRemote: false
    }),
    prompt: '',
    allowEmptyPromptLaunch: true
  })
  expect(startup?.launchCommand).toContain("'--model' 'claude-sonnet-5-5'")
  expect(startup?.launchCommand).not.toContain('claude-opus-5-5')
})

it.each([5, 50])(
  'isolates closed owner projection work across unrelated publications for %s actual rows',
  async (rows) => {
    configure({ nativeChatProviders: {}, agentPermissionDefault: 'own' })
    const sources = vi.spyOn(sourceProjection, 'sourceControlPickerDraft')
    const analyses = vi.spyOn(choiceAnalysis, 'analyzeAgentChoiceArgs')
    const catalogs = vi.spyOn(pickerCatalog, 'getAgentSessionOptionLaunchCatalog')
    const reconciliations = vi.spyOn(reconciliation, 'reconcileAgentChoiceArgsDetailed')
    const profiles = vi.spyOn(launchProfile, 'projectAgentLaunchProfile')
    const setters: ((raw: string) => void)[] = []
    const raw = `${Array.from({ length: rows * 6 }, (_, i) => `--settings '{"theme":"${i}"}'`).join(' ')} --model claude-sonnet-5-5`
    function Recipe({ index }: { index: number }) {
      const [args, setArgs] = useState(raw)
      setters[index] = setArgs
      return (
        <SourceControlActionAgentPicker
          agent="claude"
          selection={canonicalSourceControlActionSelection({ agentId: 'claude', agentArgs: args })}
          onPick={unused}
        />
      )
    }
    render(
      <TooltipProvider>
        {Array.from({ length: rows }, (_, index) => (
          <Recipe key={index} index={index} />
        ))}
      </TooltipProvider>
    )
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Select agent' })).toHaveLength(rows)
    )
    await act(async () => {})
    const counts = () => ({
      observers: renderWork.observers.mock.calls.length,
      consumers: renderWork.consumers.mock.calls.length,
      sources: sources.mock.calls.length,
      analyses: analyses.mock.calls.length,
      catalogs: catalogs.mock.calls.length,
      reconciliations: reconciliations.mock.calls.length,
      profiles: profiles.mock.calls.length
    })
    const before = counts()
    await act(() =>
      loadHostStructuredAgents(
        'runtime:beta',
        [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY],
        'beta-1'
      )
    )
    expect(counts().observers).toBeGreaterThan(before.observers)
    expect(counts()).toEqual({ ...before, observers: counts().observers })
    act(() => useAppStore.setState({ settingsSearchQuery: 'unrelated search' }))
    expect(counts()).toEqual({ ...before, observers: counts().observers })
    // A new whole settings object must not make unrelated settings an owner input.
    act(() => configure({ theme: 'light' }))
    await act(() =>
      loadHostStructuredAgents(
        'runtime:beta',
        [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY],
        'beta-2'
      )
    )
    expect(counts()).toEqual({ ...before, observers: counts().observers })
    act(() => setters[0]('--model claude-opus-5-5'))
    expect(counts().consumers - before.consumers).toBe(1)
    expect(counts().sources).toBeGreaterThan(before.sources)
    expect(counts().analyses).toBeGreaterThan(before.analyses)
    expect(screen.getAllByRole('button', { name: 'Select agent' })[0].textContent).toMatch(
      /Opus|claude-opus-5-5/
    )
    for (const button of screen.getAllByRole('button', { name: 'Select agent' }).slice(1)) {
      expect(button.textContent).toMatch(/Sonnet|claude-sonnet-5-5/)
    }
    fireEvent.pointerDown(screen.getAllByRole('button', { name: 'Select agent' })[0], {
      button: 0,
      ctrlKey: false
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Configure Claude' }))
    expect(
      await screen.findByRole('button', { name: 'Remove --model claude-opus-5-5' })
    ).toBeDefined()
  }
)

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
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  expect(template).toHaveProperty('value', 'New unrelated template')
  await open()
  expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty(
    'value',
    '--latest-pending'
  )
})

it.each([5, 50])(
  'selects actual global/repo producer inputs before lower source work for %s owner rows',
  async (count) => {
    const config = normalizeSourceControlAiSettings({
      ...getDefaultSourceControlAiSettings(),
      actions: {
        fixChecks: {
          agentId: 'claude',
          agentArgs: '--model claude-sonnet-5-5',
          commandInputTemplate: 'Do work'
        }
      }
    })
    configure({ nativeChatProviders: {}, sourceControlAi: config })
    const repo = {
      ...TEST_REPO,
      sourceControlAi: {
        actionOverrides: {
          fixChecks: { agentId: 'claude' as const, agentArgs: '--model claude-sonnet-5-5' }
        }
      }
    }
    useAppStore.setState({ repos: [repo] })
    const sources = vi.spyOn(sourceProjection, 'sourceControlPickerDraft')
    const analyses = vi.spyOn(choiceAnalysis, 'analyzeAgentChoiceArgs')
    const catalogs = vi.spyOn(pickerCatalog, 'getAgentSessionOptionLaunchCatalog')
    const reconciliations = vi.spyOn(reconciliation, 'reconcileAgentChoiceArgsDetailed')
    const profiles = vi.spyOn(launchProfile, 'projectAgentLaunchProfile')
    const notices = vi.fn()
    const unsubscribe = useAppStore.subscribe(notices)
    function Producers() {
      const settings = useAppStore((state) => state.settings)
      const config = settings!.sourceControlAi!
      return (
        <>
          {Array.from({ length: count }, (_, index) => (
            <div key={index}>
              <SourceControlAiActionRecipeDefaults
                config={config}
                defaultTuiAgent="claude"
                searchQuery=""
                writeConfig={async () => {}}
              />
              <RepositorySourceControlAiSection repo={repo} updateRepo={unused} />
            </div>
          ))}
        </>
      )
    }
    try {
      render(
        <TooltipProvider>
          <Producers />
        </TooltipProvider>
      )
      await act(async () => {})
      const lower = () => ({
        sources: sources.mock.calls.length,
        analyses: analyses.mock.calls.length,
        catalogs: catalogs.mock.calls.length,
        reconciliations: reconciliations.mock.calls.length,
        profiles: profiles.mock.calls.length,
        renders: renderWork.consumers.mock.calls.length
      })
      const before = lower()
      expect(before.sources).toBeGreaterThan(0)
      expect(before.catalogs).toBeGreaterThan(0)
      expect(before.profiles).toBeGreaterThan(0)
      const observed = renderWork.observers.mock.calls.length
      await act(() =>
        loadHostStructuredAgents(
          'runtime:beta',
          [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY],
          'actual-success'
        )
      )
      expect(lower()).toEqual(before)
      expect(renderWork.observers.mock.calls.length).toBeGreaterThan(observed)
      vi.mocked(callRuntimeRpc).mockRejectedValueOnce(new Error('beta offline'))
      await act(() =>
        loadHostStructuredAgents(
          'runtime:beta',
          [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY],
          'actual-failure'
        )
      )
      expect(lower()).toEqual(before)
      act(() => retainHostStructuredAgents(new Set(['local'])))
      expect(lower()).toEqual(before)
      act(() => configure({ theme: 'light' }))
      expect(notices).toHaveBeenCalled()
      expect(lower()).toEqual(before)
      act(() => useAppStore.setState({ settingsSearchQuery: 'unrelated' }))
      expect(lower()).toEqual(before)
      act(() => configure({ agentDefaultArgs: { claude: '--model claude-opus-5-5' } }))
      expect(lower().sources).toBeGreaterThan(before.sources)
      expect(lower().catalogs).toBeGreaterThan(before.catalogs)
      expect(lower().renders).toBeGreaterThan(before.renders)
    } finally {
      unsubscribe()
    }
  }
)

it.each([5, 50])(
  'isolates actual Customize labels from unrelated publications for %s mounted forms',
  async (rows) => {
    const { mountSourceDialog } =
      await import('../right-sidebar/source-control-action-dialog.test-fixture')
    const { SourceControlAgentActionDialog } =
      await import('../right-sidebar/SourceControlAgentActionDialog')
    const inventory = await import('../agent/use-agent-launch-picker-inventory')
    const inner = vi.spyOn(inventory, 'useAgentLaunchPickerInventory')
    const sources = vi.spyOn(sourceProjection, 'sourceControlPickerDraft')
    const analyses = vi.spyOn(choiceAnalysis, 'analyzeAgentChoiceArgs')
    const catalogs = vi.spyOn(pickerCatalog, 'getAgentSessionOptionLaunchCatalog')
    const reconciliations = vi.spyOn(reconciliation, 'reconcileAgentChoiceArgsDetailed')
    const profiles = vi.spyOn(launchProfile, 'projectAgentLaunchProfile')
    const mounted = mountSourceDialog(
      { agentId: 'claude', agentArgs: '--model claude-sonnet-5-5', surface: 'terminal' },
      {}
    )
    const dialogs = Array.from({ length: rows - 1 }, (_, index) => ({
      id: `customize-dialog-${index}`
    }))
    render(
      <TooltipProvider>
        {dialogs.map((dialog) => (
          <SourceControlAgentActionDialog key={dialog.id} {...mounted.props} />
        ))}
      </TooltipProvider>
    )
    await waitFor(() =>
      expect(
        Array.from(
          document.querySelectorAll<HTMLButtonElement>('button[aria-label="Select agent"]')
        )
      ).toHaveLength(rows)
    )
    await act(async () => {})
    const work = () => ({
      sources: sources.mock.calls.length,
      analyses: analyses.mock.calls.length,
      catalogs: catalogs.mock.calls.length,
      reconciliations: reconciliations.mock.calls.length,
      profiles: profiles.mock.calls.length,
      inner: inner.mock.calls.length
    })
    const baseline = work()
    expect(baseline.sources).toBeGreaterThan(0)
    expect(baseline.catalogs).toBeGreaterThan(0)
    const observed = renderWork.observers.mock.calls.length
    await act(() =>
      loadHostStructuredAgents(
        'runtime:beta',
        [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY],
        'customize-success'
      )
    )
    expect(work()).toEqual(baseline)
    expect(renderWork.observers.mock.calls.length).toBeGreaterThan(observed)
    vi.mocked(callRuntimeRpc).mockRejectedValueOnce(new Error('beta offline'))
    await act(() =>
      loadHostStructuredAgents(
        'runtime:beta',
        [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY],
        'customize-failure'
      )
    )
    expect(work()).toEqual(baseline)
    act(() => retainHostStructuredAgents(new Set(['local'])))
    expect(work()).toEqual(baseline)
    act(() => configure({ theme: 'light' }))
    expect(work()).toEqual(baseline)
    act(() => useAppStore.setState({ settingsSearchQuery: 'unrelated customize search' }))
    expect(work()).toEqual(baseline)
    act(() => configure({ agentLaunchChoices: { claude: { model: 'claude-opus-5-5' } } }))
    expect(work().inner).toBeGreaterThan(baseline.inner)
    expect(work().sources).toBeGreaterThan(baseline.sources)
    // The own raw choice still outranks the changed fallback default.
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('button[aria-label="Select agent"]')
      ).every((button) => /Sonnet|claude-sonnet-5-5/.test(button.textContent ?? ''))
    ).toBe(true)
    act(() => mounted.controller.onAgentArgsChange('--model claude-opus-5-5'))
    expect(
      Array.from(
        document.querySelectorAll<HTMLButtonElement>('button[aria-label="Select agent"]')
      ).filter((button) => /Opus|claude-opus-5-5/.test(button.textContent ?? ''))
    ).toHaveLength(1)
  }
)
