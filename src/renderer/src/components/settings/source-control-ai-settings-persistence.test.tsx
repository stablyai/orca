// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { ChatNamingSetting } from './ChatNamingSetting'
import { CommitMessageAiPane } from './CommitMessageAiPane'
import { useSettingsInteractionController } from './use-settings-interaction-controller'
import {
  persist,
  pickerLocaleFixture,
  settingsModel,
  type SettingsPersistenceModel
} from './__fixtures__/settings-persistence-test-fixture'
import * as selection from '../../../../shared/source-control-launch-agent-selection'
import * as lifts from '../../../../shared/source-control-action-permission-lift'
import * as shell from '../../../../shared/tui-agent-startup-shell'
import { TooltipProvider } from '../ui/tooltip'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../shared/source-control-ai'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

beforeEach(() => useAppStore.setState({ settingsSearchQuery: '' }))
afterEach(() => setLocalRuntimeCapabilitiesForTests(null))

function GitPersistenceHarness({ model }: { model: SettingsPersistenceModel }) {
  const settings = useAppStore((state) => state.settings)
  const controller = useSettingsInteractionController(model)
  if (!settings) {
    throw new Error('Settings fixture is missing')
  }
  return (
    <>
      <CommitMessageAiPane
        settings={settings}
        updateSettings={model.updateSettings}
        writeSourceControlAiSettings={controller.writeSourceControlAiSettingsOrThrow}
      />
      <ChatNamingSetting
        settings={settings}
        updateSettings={model.updateSettings}
        writeSourceControlAiSettings={controller.writeSourceControlAiSettingsOrThrow}
        onDirtyChange={model.setHasUnsavedChatPromptChanges}
      />
    </>
  )
}

it('consumes an actual Git toggle failure and lets the following Chat write succeed', async () => {
  const model = settingsModel()
  persist.mockRejectedValueOnce(new Error('Settings disk is unavailable'))
  render(<GitPersistenceHarness model={model} />)
  const naming = document.getElementById('chat-names')
  if (!naming) {
    throw new Error('Chat naming section is missing')
  }
  fireEvent.click(within(naming).getByRole('button', { name: 'Advanced' }))
  const toggle = screen.getByRole('switch', { name: 'Show Source Control AI actions' })
  fireEvent.click(toggle)
  await waitFor(() =>
    expect(console.error).toHaveBeenCalledWith('Failed to update settings:', expect.any(Error))
  )
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(screen.getByRole('combobox'))
  fireEvent.click(screen.getByRole('option', { name: 'Custom command' }))
  await waitFor(() =>
    expect(
      useAppStore.getState().settings?.sourceControlAi?.actions?.conversationName?.agentId
    ).toBe('custom')
  )
  expect(useAppStore.getState().settings?.sourceControlAi?.actions?.conversationName?.agentId).toBe(
    'custom'
  )
  expect(useAppStore.getState().settings?.sourceControlAi?.enabled).toBe(false)
  expect(persist).toHaveBeenCalledTimes(2)
})

it('does not let a failed actual Git agent selection roll back a queued Chat selection', async () => {
  const settings = useAppStore.getState().settings
  if (!settings?.sourceControlAi) {
    throw new Error('Settings fixture is missing')
  }
  useAppStore.setState({
    settings: { ...settings, sourceControlAi: { ...settings.sourceControlAi, enabled: true } }
  })
  const originalCommit = normalizeSourceControlAiSettings(settings.sourceControlAi).actions
    ?.commitMessage
  let rejectGit = (_error: Error): void => {}
  persist.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectGit = reject
      })
  )
  render(<GitPersistenceHarness model={settingsModel()} />)
  const naming = document.getElementById('chat-names')
  if (!naming) {
    throw new Error('Chat naming section is missing')
  }
  fireEvent.click(within(naming).getByRole('button', { name: 'Advanced' }))
  const agents = screen.getAllByRole('combobox')
  const gitAgent = agents[0]
  const chatAgent = agents.at(-1)
  if (!gitAgent || !chatAgent || agents.length < 2) {
    throw new Error('Git and Chat agent controls are missing')
  }
  fireEvent.click(gitAgent)
  fireEvent.click(screen.getByRole('option', { name: 'Custom command' }))
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  fireEvent.click(chatAgent)
  fireEvent.click(screen.getByRole('option', { name: 'Custom command' }))
  await act(async () => rejectGit(new Error('Settings disk is unavailable')))
  await waitFor(() =>
    expect(
      useAppStore.getState().settings?.sourceControlAi?.actions?.conversationName?.agentId
    ).toBe('custom')
  )
  expect(useAppStore.getState().settings?.sourceControlAi?.actions?.commitMessage).toEqual(
    originalCommit
  )
  expect(persist).toHaveBeenCalledTimes(2)
})

it('global owner: bounded controlled edits, failed/same selection and no-op save', async () => {
  setLocalRuntimeCapabilitiesForTests([])
  const settings = useAppStore.getState().settings
  if (!settings) {
    throw new Error('Missing settings')
  }
  useAppStore.setState({
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] },
    repos: Array.from({ length: 32 }, (_, i) => ({
      id: `repo-${i}`,
      path: `/repo-${i}`,
      displayName: `Repo ${i}`,
      badgeColor: '',
      addedAt: 0
    })),
    settings: {
      ...settings,
      nativeChatProviders: { claude: false, codex: false },
      sourceControlAi: normalizeSourceControlAiSettings({
        ...getDefaultSourceControlAiSettings(),
        enabled: true,
        actions: {
          fixChecks: {
            agentId: 'claude',
            agentArgs: '',
            launchPreferences: { agentId: 'claude', model: 'sonnet', options: { effort: 'high' } }
          }
        }
      })
    }
  })
  const summary = vi.spyOn(selection, 'summarizeReposOverridingActionRecipe')
  const lift = vi.spyOn(lifts, 'liftActionPermissionArgs')
  const tokenize = vi.spyOn(shell, 'tokenizeStartupCommand')
  render(
    <TooltipProvider>
      <GitPersistenceHarness model={settingsModel()} />
    </TooltipProvider>
  )
  const heading = screen.getByText('Broken checks fixes')
  const container = heading.closest('.rounded-md')
  if (!(container instanceof HTMLElement)) {
    throw new Error('Missing recipe row')
  }
  const row = within(container)
  const openSetup = async () => {
    const trigger = row.getByRole('button', { name: 'Select agent' })
    await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
    return screen.getByRole('textbox', { name: 'Arguments' })
  }
  let input = await openSetup()
  await waitFor(() => expect(input).toHaveProperty('disabled', false))
  summary.mockClear()
  lift.mockClear()
  const inputWork: number[][] = []
  for (const n of [32, 320]) {
    fireEvent.change(input, { target: { value: '--verbose 999' } })
    tokenize.mockClear()
    for (let i = 0; i < n; i++) {
      fireEvent.change(input, { target: { value: `--verbose ${String(i).padStart(3, '0')}` } })
    }
    expect(persist).not.toHaveBeenCalled()
    expect(summary).not.toHaveBeenCalled()
    expect(lift).not.toHaveBeenCalled()
    const work = [
      tokenize.mock.calls.length,
      tokenize.mock.calls.reduce((sum, [text]) => sum + text.length, 0)
    ]
    expect(work[0]).toBeGreaterThan(n)
    if (n === 320) {
      work.forEach((value, i) => expect(value).toBeLessThanOrEqual(10 * inputWork[0][i]))
    }
    inputWork.push(work)
    process.stdout.write(
      `${JSON.stringify({ metric: 'permission-global-input-work', edits: n, work })}\n`
    )
  }
  fireEvent.change(input, { target: { value: '--dangerously-skip-permissions --verbose' } })
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  let reject = (_error: Error): void => {}
  persist.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      })
  )
  fireEvent.pointerDown(row.getByRole('button', { name: 'Select agent' }), {
    button: 0,
    ctrlKey: false
  })
  fireEvent.click(screen.getByRole('menuitem', { name: /Codex/ }))
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  // Actual global writer publishes only after success; failed selection must retain this later edit.
  input = await openSetup()
  fireEvent.change(input, { target: { value: '--verbose newer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  await act(async () => reject(new Error('disk unavailable')))
  await waitFor(() =>
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to/),
      expect.any(Error)
    )
  )
  expect(row.getByRole('button', { name: 'Select agent' }).textContent).toContain('Claude')
  fireEvent.pointerDown(row.getByRole('button', { name: 'Select agent' }), {
    button: 0,
    ctrlKey: false
  })
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: /Claude/ }))
  })
  expect(persist).toHaveBeenCalledTimes(2)
  expect(row.getByRole('button', { name: 'Select agent' }).textContent).toContain('Claude')
  persist.mockRejectedValueOnce(new Error('Save disk unavailable'))
  fireEvent.click(row.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(console.error).toHaveBeenCalledWith(new Error('Save disk unavailable'))
  )
  fireEvent.click(row.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(4))
  expect(useAppStore.getState().settings?.sourceControlAi?.actions?.fixChecks).toMatchObject({
    agentId: 'claude',
    agentArgs: '--verbose newer',
    launchPreferences: {
      agentId: 'claude',
      modelSelection: {
        base: 'default',
        model: { agentId: 'claude', value: 'sonnet' },
        options: { effort: { agentId: 'claude', value: 'high' } }
      },
      permissionMode: 'full-access'
    }
  })
  await waitFor(() =>
    expect(row.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  )
  expect(summary).not.toHaveBeenCalled()
})

it('isolates equal recipe drafts, invalidates Discard and saves permission-only edits without Args ownership', async () => {
  setLocalRuntimeCapabilitiesForTests([])
  const settings = useAppStore.getState().settings!
  useAppStore.setState({
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] },
    settings: {
      ...settings,
      nativeChatProviders: {},
      agentDefaultArgs: { claude: '--verbose' },
      agentPermissionDefault: 'own',
      sourceControlAi: normalizeSourceControlAiSettings({
        ...getDefaultSourceControlAiSettings(),
        enabled: true,
        actions: { fixChecks: { agentId: 'claude' }, resolveConflicts: { agentId: 'claude' } }
      })
    }
  })
  render(
    <TooltipProvider>
      <GitPersistenceHarness model={settingsModel()} />
    </TooltipProvider>
  )
  const row = (label: string) =>
    within(screen.getByText(label).closest<HTMLElement>('.rounded-md')!)
  const first = row('Broken checks fixes')
  const second = row('Conflict resolution')
  const open = async (target: ReturnType<typeof row>) => {
    const trigger = target.getByRole('button', { name: 'Select agent' })
    await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
    const input = screen.getByRole('textbox', { name: 'Arguments' })
    await waitFor(() => expect(input).toHaveProperty('disabled', false))
    return input
  }
  const dismiss = () => {
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Arguments' }), { key: 'Escape' })
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  }
  let input = await open(first)
  fireEvent.change(input, { target: { value: '--unaccepted' } })
  dismiss()
  input = await open(second)
  expect(input).toHaveProperty('value', '--verbose')
  dismiss()
  input = await open(first)
  expect(input).toHaveProperty('value', '--unaccepted')
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  fireEvent.click(first.getByRole('button', { name: 'Discard' }))
  input = await open(first)
  expect(input).toHaveProperty('value', '--verbose')
  fireEvent.keyDown(screen.getByRole('button', { name: 'Claude permissions' }), {
    key: 'ArrowDown'
  })
  fireEvent.click(
    screen.getAllByRole('menuitemradio').find((item) => item.textContent?.startsWith('Ask'))!
  )
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  fireEvent.click(first.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(
      useAppStore.getState().settings?.sourceControlAi?.actions?.fixChecks?.launchPreferences
        ?.permissionMode
    ).toBe('ask')
  )
  expect(
    useAppStore.getState().settings?.sourceControlAi?.actions?.fixChecks?.agentArgs
  ).toBeUndefined()
  act(() =>
    useAppStore.setState(({ settings }) => ({
      settings: settings && { ...settings, agentDefaultArgs: { claude: '--debug' } }
    }))
  )
  input = await open(first)
  expect(input).toHaveProperty('value', '--debug')
})

it.each(['global', 'repo'] as const)(
  'updates the mounted %s default picker and cached row text on language and resource events',
  async (scope) => {
    const locale = await pickerLocaleFixture()
    const { i18n } = locale
    const { SourceControlAiActionRecipeDefaults } =
      await import('./SourceControlAiActionRecipeDefaults')
    const { RepositorySourceControlAiSection } =
      await import('./repository/source-control/RepositorySourceControlAiSection')
    const { TEST_REPO } = await import('@/store/slices/worktrees-slice-test-fixtures')
    const config = normalizeSourceControlAiSettings({
      ...getDefaultSourceControlAiSettings(),
      enabled: true,
      actions: { fixChecks: { agentId: null } }
    })
    useAppStore.setState(({ settings }) => ({
      settings: settings && { ...settings, sourceControlAi: config },
      localDetectedAgentIdsByContext: { host: ['claude', 'codex'] },
      repos: [TEST_REPO]
    }))
    const write = vi.fn()
    const revisions = await import('@/i18n/translation-resource-version')
    const subscribe = revisions.subscribeTranslationResourceVersion
    const disposals: ReturnType<typeof vi.fn>[] = []
    vi.spyOn(revisions, 'subscribeTranslationResourceVersion').mockImplementation((listener) => {
      const stop = vi.fn(subscribe(listener))
      disposals.push(stop)
      return stop
    })
    const view = render(
      <TooltipProvider>
        {scope === 'global' ? (
          <SourceControlAiActionRecipeDefaults
            config={config}
            searchQuery=""
            defaultTuiAgent="claude"
            writeConfig={write}
          />
        ) : (
          <RepositorySourceControlAiSection repo={TEST_REPO} updateRepo={write} />
        )}
      </TooltipProvider>
    )
    try {
      await act(async () => {})
      expect(screen.getAllByText('Use default agent').length).toBeGreaterThan(0)
      if (scope === 'repo') {
        expect(screen.getByText('Action recipes')).toBeTruthy()
      }
      await act(() => i18n.changeLanguage('es'))
      expect(
        screen
          .getAllByRole('button', { name: 'Seleccionar agente' })
          .some((button) => button.textContent?.includes('Use default agent'))
      ).toBe(false)
      expect(screen.getAllByText('Usar agente predeterminado').length).toBeGreaterThan(0)
      if (scope === 'repo') {
        expect(screen.getByText('Recetas de acción')).toBeTruthy()
      }
      act(() =>
        i18n.addResource(
          'es',
          'translation',
          'auto.components.settings.SourceControlAiActionRecipeDefaults.ee0e5c2a48',
          'Predeterminado actualizado'
        )
      )
      expect(screen.getAllByText('Predeterminado actualizado').length).toBeGreaterThan(0)
      act(() =>
        i18n.addResource(
          'es',
          'translation',
          'auto.components.settings.source.control.action.recipe.options.fixChecks',
          'Descripción actualizada'
        )
      )
      if (scope === 'repo') {
        expect(screen.getByText('Descripción actualizada')).toBeTruthy()
      }
      expect(write).not.toHaveBeenCalled()
    } finally {
      view.unmount()
      expect(disposals.length).toBeGreaterThan(0)
      for (const stop of disposals) {
        expect(stop).toHaveBeenCalledOnce()
      }
      await locale.restore()
    }
  }
)

it('renders current native text-agent facts for a normalized legacy model recipe', async () => {
  const { RepositorySourceControlAiSection } =
    await import('./repository/source-control/RepositorySourceControlAiSection')
  const { TEST_REPO } = await import('@/store/slices/worktrees-slice-test-fixtures')
  const menu = await import('../tab-bar/use-new-tab-agent-menu-rows')
  const observation = vi.spyOn(menu, 'useAgentMenuObservation')
  const unused = vi.fn()
  const configure = (
    patch: Partial<NonNullable<ReturnType<typeof useAppStore.getState>['settings']>>
  ) => useAppStore.setState(({ settings }) => ({ settings: settings && { ...settings, ...patch } }))
  const { agentLaunchSettingsMutationUpdates } =
    await import('../../../../shared/agent-launch-settings')
  const config = normalizeSourceControlAiSettings({
    ...getDefaultSourceControlAiSettings(),
    actions: {
      commitMessage: { agentId: null, launchPreferences: { agentId: 'claude', model: 'opus' } }
    }
  })
  configure({ sourceControlAi: config, defaultTuiAgent: 'claude', disabledTuiAgents: [] })
  useAppStore.setState({
    repos: [TEST_REPO],
    detectedAgentIds: ['claude', 'codex'],
    localDetectedAgentIdsByContext: { host: ['claude', 'codex'] }
  })
  render(
    <TooltipProvider>
      <RepositorySourceControlAiSection repo={TEST_REPO} updateRepo={unused} />
    </TooltipProvider>
  )
  await act(async () => {})
  const section =
    document.querySelector<HTMLElement>('[data-settings-section$="commitMessage"]') ??
    screen.getByText('Commit message').closest<HTMLElement>('.rounded-md')
  if (!section) {
    throw new Error('Missing Commit message row')
  }
  const row = within(section)
  expect(row.getByText('Global custom args')).toBeTruthy()
  const input = row.getByPlaceholderText('--model sonnet')
  expect(input).toHaveProperty('value', '')
  const { sameAgentLaunchPickerModel } = await import('../tab-bar/new-tab-agent-menu-model')
  const model = observation.mock.results.at(-1)!.value.model
  for (const [host, label] of [
    [null, 'Global custom args'],
    [['codex'], 'No args'],
    [['claude', 'codex'], 'Global custom args']
  ] as const) {
    act(() => useAppStore.setState({ localDetectedAgentIdsByContext: { host: host && [...host] } }))
    expect(sameAgentLaunchPickerModel(model, observation.mock.results.at(-1)!.value.model)).toBe(
      true
    )
    expect(row.getByText(label)).toBeTruthy()
    expect(input).toHaveProperty('value', '')
  }
  const settings = useAppStore.getState().settings
  if (!settings) {
    throw new Error('Missing settings')
  }
  act(() =>
    configure(
      agentLaunchSettingsMutationUpdates(
        settings,
        { type: 'availability', agent: 'claude', enabled: false },
        'darwin'
      )
    )
  )
  expect(row.getByText('No args')).toBeTruthy()
  expect(input).toHaveProperty('value', '')
  expect(input).toHaveProperty('placeholder', '--model sonnet')
  expect(useAppStore.getState().settings?.sourceControlAi?.actions?.commitMessage).toEqual(
    config.actions?.commitMessage
  )
  expect(unused).not.toHaveBeenCalled()
})
