// @vitest-environment happy-dom
import type { ComponentProps } from 'react'
import { CommitMessageAiPane } from './CommitMessageAiPane'
import { getDefaultSourceControlAiSettings } from '../../../../shared/source-control-ai'
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { setSourceControlActionDefault } from '../../../../shared/source-control-ai-actions'
import {
  normalizeSourceControlAiSettings,
  projectSourceControlAiToLegacyCommitMessageAi,
  resolveSourceControlAiForOperation
} from '../../../../shared/source-control-ai'
import { planCommitMessageGeneration } from '../../../../shared/commit-message-plan'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type {
  SourceControlAiSettings,
  SourceControlAiSettingsPatch
} from '../../../../shared/source-control-ai-types'
import { useAiCommitPrSettings } from '../feature-wall/useAiCommitPrSettings'
import { useSourceControlActionRecipeDraftState } from './source-control-action-recipe-draft-state'
import { useAppStore } from '../../store'
import {
  renderChatSettingsSection,
  type ChatSettingsRenderContext
} from './settings-interface-secondary-section-renderers'
import { getChatNamingSearchEntry } from './chat-naming-search'
import { useSettingsInteractionController } from './use-settings-interaction-controller'
import {
  persist,
  settingsModel,
  type SettingsPersistenceModel
} from './__fixtures__/settings-persistence-test-fixture'
import { ActiveSettingsSectionProvider } from './SettingsSection'
import { renderGlobalCommitCard } from './__fixtures__/global-commit-card-test-fixture'
import { TooltipProvider } from '../ui/tooltip'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

function ChatPersistenceHarness({ model }: { model: SettingsPersistenceModel }) {
  const settings = useAppStore((state) => state.settings)
  const controller = useSettingsInteractionController(model)
  if (!settings) {
    throw new Error('Settings fixture is missing')
  }
  const context = {
    model: { ...model, settings, fontSuggestions: [] },
    interactions: controller,
    navigation: { getSectionSearchEntries: () => [getChatNamingSearchEntry()] },
    view: { isSectionMounted: () => true }
  } satisfies ChatSettingsRenderContext
  const section = renderChatSettingsSection(context)
  return (
    <TooltipProvider>
      <ActiveSettingsSectionProvider value="chat">{section}</ActiveSettingsSectionProvider>
    </TooltipProvider>
  )
}

it('passes the existing paired-web capability through the actual Chat renderer', () => {
  useAppStore.setState({ settingsSearchQuery: '' })
  const model = settingsModel()
  render(<ChatPersistenceHarness model={{ ...model, showDesktopOnlySettings: false }} />)
  expect(screen.getByRole('spinbutton', { name: 'Text size' })).toBeTruthy()
  expect(screen.queryByRole('switch', { name: 'Name chats automatically' })).toBeNull()
  expect(persist).not.toHaveBeenCalled()
})

it('keeps the Chat draft and guard after actual persistence fails, then saves it on retry', async () => {
  const model = settingsModel()
  const savedRecipe = model.settings?.sourceControlAi?.actions?.conversationName
  persist.mockRejectedValueOnce(new Error('Settings disk is unavailable'))
  render(<ChatPersistenceHarness model={model} />)
  const naming = document.getElementById('chat-names')
  if (!naming) {
    throw new Error('Chat naming section is missing')
  }
  fireEvent.click(within(naming).getByRole('button', { name: 'Advanced' }))
  const template = screen.getByText('Command template').nextElementSibling
  const args = screen.getByText('Arguments').nextElementSibling
  if (!(template instanceof HTMLTextAreaElement) || !(args instanceof HTMLInputElement)) {
    throw new Error('Chat recipe controls are missing')
  }
  fireEvent.change(template, { target: { value: 'Keep: {firstPrompt}' } })
  fireEvent.change(args, { target: { value: '--model fast' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith('Could not save chat name settings.')
  )
  expect(screen.getByDisplayValue('Keep: {firstPrompt}')).toBeTruthy()
  expect(screen.getByDisplayValue('--model fast')).toBeTruthy()
  expect(model.setHasUnsavedChatPromptChanges).toHaveBeenLastCalledWith(true)
  expect(useAppStore.getState().settings?.sourceControlAi?.actions?.conversationName).toEqual(
    savedRecipe
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(useAppStore.getState().settings?.sourceControlAi?.actions?.conversationName).toEqual({
      commandInputTemplate: 'Keep: {firstPrompt}',
      agentArgs: '--model fast'
    })
  )
  expect(model.setHasUnsavedChatPromptChanges).toHaveBeenLastCalledWith(false)
  expect(useAppStore.getState().settings?.sourceControlAi).toMatchObject({
    enabled: false,
    actions: { commitMessage: { commandInputTemplate: 'Keep the Git recipe' } }
  })
  expect(persist).toHaveBeenCalledTimes(2)
})

it('retains the legacy Git failure contract and composes later queued naming writes', async () => {
  const previousBranch = normalizeSourceControlAiSettings(
    useAppStore.getState().settings?.sourceControlAi
  ).actions?.branchName
  persist.mockRejectedValueOnce(new Error('Settings disk is unavailable'))
  const { result } = renderHook(() => useSettingsInteractionController(settingsModel()))
  await act(async () => {
    const failed = result.current.writeSourceControlAiSettings((current) => ({
      actions: setSourceControlActionDefault(current.actions, 'branchName', {
        commandInputTemplate: 'Must not persist'
      })
    }))
    const settled = expect(failed).resolves.toBeUndefined()
    const agent = result.current.writeSourceControlAiSettingsOrThrow((current) => ({
      actions: setSourceControlActionDefault(current.actions, 'conversationName', {
        agentId: 'codex'
      })
    }))
    const recipe = result.current.writeSourceControlAiSettingsOrThrow((current) => ({
      actions: setSourceControlActionDefault(current.actions, 'conversationName', {
        agentArgs: '--model fast',
        commandInputTemplate: 'Name {firstPrompt}'
      })
    }))
    await Promise.all([settled, agent, recipe])
  })
  expect(useAppStore.getState().settings?.sourceControlAi).toMatchObject({
    enabled: false,
    actions: {
      commitMessage: { commandInputTemplate: 'Keep the Git recipe' },
      conversationName: {
        agentId: 'codex',
        agentArgs: '--model fast',
        commandInputTemplate: 'Name {firstPrompt}'
      }
    }
  })
  expect(useAppStore.getState().settings?.sourceControlAi?.actions?.branchName).toEqual(
    previousBranch
  )
  expect(persist).toHaveBeenCalledTimes(3)
})

it('configures the offered Chat custom command without enabling Git or writing on each keystroke', async () => {
  const model = settingsModel()
  render(<ChatPersistenceHarness model={model} />)
  const naming = document.getElementById('chat-names')
  if (!naming) {
    throw new Error('Chat naming section is missing')
  }
  fireEvent.click(within(naming).getByRole('button', { name: 'Advanced' }))
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), {
    button: 0,
    ctrlKey: false
  })
  fireEvent.click(screen.getByRole('menuitem', { name: 'Custom command' }))
  const command = await screen.findByRole('textbox', { name: 'Custom command' })
  expect(persist).toHaveBeenCalledTimes(1)
  fireEvent.change(command, { target: { value: 'name-tool' } })
  fireEvent.change(command, { target: { value: 'name-tool {prompt}' } })
  expect(persist).toHaveBeenCalledTimes(1)
  expect(model.setHasUnsavedChatPromptChanges).toHaveBeenLastCalledWith(true)
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(useAppStore.getState().settings?.sourceControlAi?.customAgentCommand).toBe(
      'name-tool {prompt}'
    )
  )
  const settings = useAppStore.getState().settings
  if (!settings) {
    throw new Error('Settings fixture is missing')
  }
  expect(
    resolveSourceControlAiForOperation({ settings, operation: 'conversationName' })
  ).toMatchObject({
    ok: true,
    value: { params: { agentId: 'custom', customAgentCommand: 'name-tool {prompt}' } }
  })
  expect(settings.sourceControlAi?.enabled).toBe(false)
  expect(settings.sourceControlAi?.actions?.commitMessage?.commandInputTemplate).toBe(
    'Keep the Git recipe'
  )
  expect(settings.sourceControlAi?.actions?.conversationName).not.toHaveProperty(
    'customAgentCommand'
  )
  expect(model.setHasUnsavedChatPromptChanges).toHaveBeenLastCalledWith(false)
  expect(persist).toHaveBeenCalledTimes(2)
})

it.each(['original-command', 'later-command'])(
  'keeps the newer %s intent while a different command save is pending',
  async (later) => {
    const settings = useAppStore.getState().settings
    if (!settings?.sourceControlAi) {
      throw new Error('Settings fixture is missing')
    }
    useAppStore.setState({
      settings: {
        ...settings,
        sourceControlAi: {
          ...settings.sourceControlAi,
          customAgentCommand: 'original-command',
          actions: { ...settings.sourceControlAi.actions, conversationName: { agentId: 'custom' } }
        }
      }
    })
    const model = settingsModel()
    let finish = (): void => {}
    persist.mockImplementationOnce(
      (updates) =>
        new Promise((resolve) => {
          finish = () => {
            const current = useAppStore.getState().settings
            if (!current) {
              throw new Error('Settings fixture is missing')
            }
            resolve({ ...current, ...updates })
          }
        })
    )
    render(<ChatPersistenceHarness model={model} />)
    const naming = document.getElementById('chat-names')
    if (!naming) {
      throw new Error('Chat naming section is missing')
    }
    fireEvent.click(within(naming).getByRole('button', { name: 'Advanced' }))
    const command = screen.getByRole('textbox', { name: 'Custom command' })
    fireEvent.change(command, { target: { value: 'submitted-command' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    fireEvent.change(command, { target: { value: later } })
    await act(async () => finish())
    expect(useAppStore.getState().settings?.sourceControlAi?.customAgentCommand).toBe(
      'submitted-command'
    )
    expect(screen.getByDisplayValue(later)).toBeTruthy()
    expect(model.setHasUnsavedChatPromptChanges).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(useAppStore.getState().settings?.sourceControlAi?.customAgentCommand).toBe(later)
    )
    expect(model.setHasUnsavedChatPromptChanges).toHaveBeenLastCalledWith(false)
    expect(persist).toHaveBeenCalledTimes(2)
  }
)

it('preserves a shared command changed elsewhere while a Chat recipe is being edited', async () => {
  const model = settingsModel()
  render(<ChatPersistenceHarness model={model} />)
  const naming = document.getElementById('chat-names')
  if (!naming) {
    throw new Error('Chat naming section is missing')
  }
  fireEvent.click(within(naming).getByRole('button', { name: 'Advanced' }))
  const template = screen.getByText('Command template').nextElementSibling
  if (!(template instanceof HTMLTextAreaElement)) {
    throw new Error('Chat recipe controls are missing')
  }
  fireEvent.change(template, { target: { value: 'Chat {firstPrompt}' } })
  await act(async () => {
    const settings = useAppStore.getState().settings
    if (!settings) {
      throw new Error('Settings fixture is missing')
    }
    await settingsModel().updateSettingsOrThrow({
      sourceControlAi: {
        ...normalizeSourceControlAiSettings(settings.sourceControlAi),
        customAgentCommand: 'changed-elsewhere'
      }
    })
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(
      useAppStore.getState().settings?.sourceControlAi?.actions?.conversationName
        ?.commandInputTemplate
    ).toBe('Chat {firstPrompt}')
  )
  expect(useAppStore.getState().settings?.sourceControlAi?.customAgentCommand).toBe(
    'changed-elsewhere'
  )
})

it.each(['global', 'repo'] as const)(
  '%s text setup saves text-catalog choices and stripped Arguments together',
  async (scope) => {
    const settings = useAppStore.getState().settings
    if (!settings) {
      throw new Error('Missing settings')
    }
    const { TEST_REPO } = await import('@/store/slices/worktrees-slice-test-fixtures')
    const { RepositorySourceControlAiSection } =
      await import('./repository/source-control/RepositorySourceControlAiSection')
    Object.assign(window.api.preflight, { detectRemoteAgents: vi.fn(async () => ['codex']) })
    const repo = {
      ...TEST_REPO,
      executionHostId: 'ssh:target%20one',
      connectionId: 'stale',
      sourceControlAi: { actionOverrides: { commitMessage: { agentId: 'codex' as const } } }
    }
    const hostKey = scope === 'repo' ? 'ssh:target one' : 'local'
    const updateRepo = vi.fn(async (id, patch) => {
      useAppStore.setState((state) => ({
        repos: state.repos.map((row) => (row.id === id ? { ...row, ...patch } : row))
      }))
      return true
    }) satisfies ComponentProps<typeof RepositorySourceControlAiSection>['updateRepo']
    useAppStore.setState({
      repos: [repo],
      settingsSearchQuery: '',
      settings: {
        ...settings,
        defaultTuiAgent: 'codex',
        sourceControlAi: normalizeSourceControlAiSettings({
          ...getDefaultSourceControlAiSettings(),
          enabled: true,
          actions: {
            commitMessage: {
              agentId: 'codex',
              agentArgs: '--model old -c model_reasoning_effort=low --verbose'
            }
          },
          modelOverridesByOperation: {
            commitMessage: { selectedModelByAgent: { codex: 'retired-model' } }
          },
          discoveredModelsByAgentByHost: {
            [hostKey]: {
              codex: [
                {
                  id: 'text-catalog-model',
                  label: 'Text catalog model',
                  thinkingLevels: [
                    { id: 'low', label: 'Low' },
                    { id: 'high', label: 'High' }
                  ],
                  defaultThinkingLevel: 'low'
                },
                {
                  id: 'text-low-only',
                  label: 'Low only model',
                  thinkingLevels: [{ id: 'low', label: 'Low' }],
                  defaultThinkingLevel: 'low'
                }
              ]
            }
          }
        })
      }
    })
    const model = settingsModel()
    function Owner() {
      const repo = useAppStore((state) => state.repos[0])
      const settings = useAppStore((state) => state.settings)!
      const controller = useSettingsInteractionController(model)
      return scope === 'repo' ? (
        <RepositorySourceControlAiSection repo={repo} updateRepo={updateRepo} />
      ) : (
        <CommitMessageAiPane
          settings={settings}
          updateSettings={model.updateSettings}
          writeSourceControlAiSettings={controller.writeSourceControlAiSettingsOrThrow}
        />
      )
    }
    render(
      <TooltipProvider>
        <Owner />
      </TooltipProvider>
    )
    const card = screen.getByText('Commit message').closest('.rounded-md')
    if (!(card instanceof HTMLElement)) {
      throw new Error('Missing commit card')
    }
    const row = within(card)
    const open = () => {
      fireEvent.pointerDown(row.getByRole('button', { name: 'Select agent' }), {
        button: 0,
        ctrlKey: false
      })
      expect(screen.getByRole('menuitem', { name: 'Use default agent' })).toBeDefined()
      expect(screen.getByRole('menuitem', { name: 'Custom command' })).toBeDefined()
      fireEvent.click(screen.getByRole('button', { name: 'Configure Codex' }))
    }
    open()
    expect(screen.getByRole('option', { name: 'Text catalog model' })).toBeDefined()
    expect(screen.queryByRole('option', { name: 'retired-model' })).toBeNull()
    expect(screen.getByRole('option', { name: /^Same as default/ }).textContent).toContain(
      'GPT-5.6 Terra'
    )
    expect(screen.queryByRole('button', { name: 'Codex permissions' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Open in' })).toBeNull()
    expect(screen.queryByText('Fast')).toBeNull()
    fireEvent.click(screen.getByRole('option', { name: 'Text catalog model' }))
    const effort = screen.getByRole('radiogroup', { name: 'Effort' })
    expect(within(effort).getByRole('radio', { name: 'High' })).toHaveProperty('disabled', false)
    fireEvent.click(within(effort).getByRole('radio', { name: 'High' }))
    fireEvent.click(screen.getByRole('option', { name: 'Low only model' }))
    expect(screen.queryByRole('radio', { name: 'High' })).toBeNull()
    expect(screen.getByRole('radio', { name: 'Low' })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('option', { name: 'Text catalog model' }))
    fireEvent.click(screen.getByRole('radio', { name: 'High' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    const save = scope === 'repo' ? updateRepo : persist
    expect(save).not.toHaveBeenCalled()
    expect(row.getByDisplayValue('--verbose')).toBeDefined()
    fireEvent.click(row.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const saved =
      scope === 'repo'
        ? updateRepo.mock.calls[0][1].sourceControlAi
        : persist.mock.calls[0][0].sourceControlAi
    expect(saved).toMatchObject({
      [scope === 'repo' ? 'actionOverrides' : 'actions']: {
        commitMessage: { agentArgs: '--verbose' }
      },
      modelOverridesByOperation: {
        commitMessage: {
          selectedModelByAgent: { codex: 'text-catalog-model' },
          selectedThinkingByModel: { 'text-catalog-model': 'high' }
        }
      }
    })
    // The registered repository's SSH host has no discovery yet still gets the pick.
    expect(
      saved?.modelOverridesByOperation?.commitMessage?.selectedModelByAgentByHost?.[
        'ssh:target one'
      ]?.codex
    ).toBe('text-catalog-model')
    await waitFor(() =>
      expect(row.getByRole('button', { name: 'Select agent' }).textContent).toContain(
        'Text catalog model · Codex · High'
      )
    )
    if (scope === 'repo') {
      expect(persist).not.toHaveBeenCalled()
      expect(
        useAppStore.getState().settings?.sourceControlAi?.actions?.commitMessage?.agentArgs
      ).toContain('--model old')
    }
    // A matching flag with no operand stays visible as Arguments-controlled after a pick.
    fireEvent.change(row.getByDisplayValue('--verbose'), {
      target: { value: '--model' }
    })
    open()
    fireEvent.click(screen.getByRole('option', { name: 'Text catalog model' }))
    expect(
      screen.getByRole('option', { name: 'Text catalog model' }).getAttribute('data-current')
    ).toBe('false')
    expect(screen.getAllByText('Set by your Arguments').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(row.getByDisplayValue('--model')).toBeDefined()
    expect(row.getByRole('button', { name: 'Select agent' }).textContent).toContain(
      'Set by your Arguments'
    )
  }
)

const SOL_DISCOVERY = {
  local: {
    opencode2: [
      {
        id: 'openai/gpt-6.1-sol',
        label: 'GPT-6.1 Sol',
        thinkingLevels: [
          { id: 'low', label: 'Low' },
          { id: 'high', label: 'High' }
        ],
        defaultThinkingLevel: 'low'
      }
    ]
  }
}

/** Effort is a read-only row naming Arguments as its owner, with no level to pick. */
function expectEffortSetByArguments() {
  expect(screen.queryByRole('radiogroup', { name: 'Effort' })).toBeNull()
  const row = screen.getByText('Effort').parentElement
  if (!row) {
    throw new Error('Missing Effort row')
  }
  expect(within(row).getByText('Set by your Arguments')).toBeDefined()
}

function plannedArgs(settings: GlobalSettings, agentArgs: string) {
  const resolved = resolveSourceControlAiForOperation({
    settings: {
      ...settings,
      sourceControlAi: {
        ...settings.sourceControlAi!,
        actions: { commitMessage: { agentId: 'opencode2', agentArgs } }
      }
    },
    operation: 'commitMessage'
  })
  if (!resolved.ok) {
    throw new Error(resolved.error)
  }
  const plan = planCommitMessageGeneration(resolved.value.params, 'prompt')
  return plan.ok ? plan.plan.args : []
}

it.each([
  ['--model vendor/model-x#high --verbose', 'opencode/gpt-5.4-mini'],
  ['--model "vendor/model-x"#high --verbose', undefined],
  ['"--model=vendor/model-x#high" --verbose', undefined],
  ['--model=vendor/model-x#high --verbose', undefined],
  ['-m vendor/model-x#high --verbose', undefined],
  ['--model vendor\\/model-x\\#high --verbose', undefined],
  ['--model vendor/model-x#high --model other/model#low --verbose', undefined]
])(
  'leaves an OpenCode 2 model set in Arguments untouched by Effort: %s',
  async (agentArgs, typedModel) => {
    const card = renderGlobalCommitCard({
      agentId: 'opencode2',
      ...(typedModel ? { selectedModelByAgent: { opencode2: typedModel } } : {}),
      actions: { commitMessage: { agentId: 'opencode2', agentArgs } }
    })
    const before = plannedArgs(useAppStore.getState().settings!, agentArgs)
    card.open('OpenCode 2')
    expectEffortSetByArguments()
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(card.row.getByDisplayValue(agentArgs)).toBeDefined()
    expect(card.row.queryByRole('button', { name: 'Save' })?.hasAttribute('disabled') ?? true).toBe(
      true
    )
    expect(plannedArgs(useAppStore.getState().settings!, agentArgs)).toEqual(before)
  }
)

it.each([
  ['every proven model flag', '--model "vendor/model-x"#high -m other/model#low --verbose', true],
  ['an unproven model flag', '--model "unfinished --verbose', false]
])(
  'an explicit OpenCode 2 Model pick takes over Effort after removing %s',
  async (_case, agentArgs, owned) => {
    const card = renderGlobalCommitCard({
      agentId: 'opencode2',
      actions: { commitMessage: { agentId: 'opencode2', agentArgs } },
      discoveredModelsByAgentByHost: SOL_DISCOVERY
    })
    card.open('OpenCode 2')
    fireEvent.click(screen.getByRole('option', { name: 'GPT-6.1 Sol' }))
    if (!owned) {
      expectEffortSetByArguments()
      return
    }
    const effort = within(screen.getByRole('radiogroup', { name: 'Effort' }))
    fireEvent.click(effort.getByRole('radio', { name: 'High' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(card.row.getByDisplayValue('--verbose')).toBeDefined()
    const settings = await card.save()
    expect(settings.sourceControlAi?.actions?.commitMessage?.agentArgs).toBe('--verbose')
    expect(plannedArgs(settings, '--verbose')).toEqual(
      expect.arrayContaining(['--model', 'openai/gpt-6.1-sol#high'])
    )
  }
)

it('previews the exact model and effort that clearing Model or Effort runs', async () => {
  const card = renderGlobalCommitCard({
    agentId: 'codex',
    selectedThinkingByModel: { 'gpt-5.4-mini': 'high' },
    actions: { commitMessage: { agentId: 'codex' } },
    modelOverridesByOperation: {
      commitMessage: {
        selectedModelByAgent: { codex: 'gpt-5.4-mini' },
        selectedThinkingByModel: { 'gpt-5.4-mini': 'xhigh', 'gpt-5.6-terra': 'high' }
      }
    }
  })
  const resolve = (settings: GlobalSettings) => {
    const resolved = resolveSourceControlAiForOperation({ settings, operation: 'commitMessage' })
    return resolved.ok && resolved.value.params
  }
  card.open('Codex')
  const effort = screen.getByRole('radiogroup', { name: 'Effort' })
  fireEvent.click(within(effort).getByRole('radio', { name: 'Same as default · High' }))
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  expect(resolve(await card.save())).toMatchObject({ model: 'gpt-5.4-mini', thinkingLevel: 'high' })

  card.open('Codex')
  const modelDefault = screen.getByRole('option', { name: /^Same as default/ })
  // The retained Terra effort, not Terra's own Low default, is what a model clear runs.
  expect(modelDefault.textContent).toBe('Same as default · GPT-5.6 Terra · High')
  fireEvent.click(modelDefault)
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  expect(resolve(await card.save())).toMatchObject({
    model: 'gpt-5.6-terra',
    thinkingLevel: 'high'
  })
})

it('lists models the installed CLI reports and saves them where generation reads them', async () => {
  const discover = vi.fn(async () => ({
    success: true,
    models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }],
    defaultModelId: 'gpt-5.6-terra'
  }))
  Object.assign(window.api, { git: { discoverCommitMessageModels: discover } })
  const card = renderGlobalCommitCard({
    agentId: 'codex',
    selectedModelByAgent: { codex: 'gpt-5.4' },
    actions: { commitMessage: { agentId: 'codex' } }
  })
  card.open('Codex')
  expect(screen.queryByRole('option', { name: 'GPT-6.1 Sol' })).toBeNull()
  expect(await screen.findByRole('option', { name: 'GPT-6.1 Sol' })).toBeDefined()
  expect(discover).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'codex' }))
  const saved = useAppStore.getState().settings?.sourceControlAi
  expect(saved?.discoveredModelsByAgentByHost?.local?.codex).toEqual([
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }
  ])
  // Listing models never changes what the user picked.
  expect(saved?.selectedModelByAgent).toEqual({ codex: 'gpt-5.4' })
})

it('shows and edits the discovered Commit message model on the AI author card', async () => {
  const settings = useAppStore.getState().settings!
  const sourceControlAi = normalizeSourceControlAiSettings({
    ...getDefaultSourceControlAiSettings(),
    enabled: true,
    agentId: 'codex',
    discoveredModelsByAgent: {
      codex: [
        {
          id: 'gpt-6.1-sol',
          label: 'GPT-6.1 Sol',
          thinkingLevels: [
            { id: 'low', label: 'Low' },
            { id: 'high', label: 'High' }
          ],
          defaultThinkingLevel: 'low'
        }
      ]
    },
    modelOverridesByOperation: {
      commitMessage: {
        selectedModelByAgent: { codex: 'gpt-6.1-sol' },
        selectedThinkingByModel: { 'gpt-6.1-sol': 'high' }
      }
    }
  })
  useAppStore.setState({
    settings: {
      ...settings,
      sourceControlAi,
      commitMessageAi: projectSourceControlAiToLegacyCommitMessageAi(sourceControlAi)
    }
  })
  const { result } = renderHook(() => useAiCommitPrSettings())
  const generated = resolveSourceControlAiForOperation({
    settings: useAppStore.getState().settings!,
    operation: 'commitMessage'
  })
  expect(generated.ok && generated.value.params).toMatchObject({
    model: 'gpt-6.1-sol',
    thinkingLevel: 'high'
  })
  expect(result.current.activeModel?.id).toBe('gpt-6.1-sol')
  expect(result.current.activeThinking).toBe('high')
  act(() => result.current.onThinkingChange('low'))
  await waitFor(() =>
    expect(
      useAppStore.getState().settings?.commitMessageAi?.selectedThinkingByModel['gpt-6.1-sol']
    ).toBe('low')
  )
})

it('saving only Arguments keeps a newer model choice saved by another editor', async () => {
  let current: SourceControlAiSettings = {
    ...getDefaultSourceControlAiSettings(),
    agentId: 'codex',
    modelOverridesByOperation: { commitMessage: { selectedModelByAgent: { codex: 'gpt-5.4' } } }
  }
  const writeConfig = async (patch: SourceControlAiSettingsPatch) => {
    current = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) }
  }
  const view = renderHook(
    ({ config }) => useSourceControlActionRecipeDraftState({ config, writeConfig }),
    { initialProps: { config: current } }
  )
  act(() => view.result.current.onActionAgentArgsChange('commitMessage', '--verbose'))
  current = {
    ...current,
    modelOverridesByOperation: { commitMessage: { selectedModelByAgent: { codex: 'gpt-5.5' } } }
  }
  view.rerender({ config: current })
  await act(() => view.result.current.saveActionTemplateDraft('commitMessage'))
  expect(current.actions?.commitMessage?.agentArgs).toBe('--verbose')
  expect(current.modelOverridesByOperation?.commitMessage?.selectedModelByAgent?.codex).toBe(
    'gpt-5.5'
  )
})

it('a global pick saved later covers the repository hosts registered by then', async () => {
  Object.assign(window.api, {
    git: { discoverCommitMessageModels: vi.fn(async () => ({ success: false, models: [] })) }
  })
  useAppStore.setState({ repos: [] })
  const card = renderGlobalCommitCard({
    agentId: 'codex',
    actions: { commitMessage: { agentId: 'codex', agentArgs: '--model gpt-5.5 --verbose' } }
  })
  card.open('Codex')
  fireEvent.click(screen.getByRole('option', { name: 'GPT-5.4' }))
  fireEvent.click(screen.getByRole('button', { name: 'Use' }))
  const { TEST_REPO } = await import('@/store/slices/worktrees-slice-test-fixtures')
  act(() =>
    useAppStore.setState({
      repos: [
        { ...TEST_REPO, id: 'ssh', executionHostId: 'ssh:added%20box', connectionId: undefined },
        { ...TEST_REPO, id: 'runtime', executionHostId: 'runtime:env-2', connectionId: undefined }
      ]
    })
  )
  const settings = await card.save()
  expect(settings.sourceControlAi?.actions?.commitMessage?.agentArgs).toBe('--verbose')
  const models = ['local', 'ssh:added box', 'runtime:env-2'].map((discoveryHostKey) => {
    const result = resolveSourceControlAiForOperation({
      settings,
      operation: 'commitMessage',
      discoveryHostKey
    })
    return result.ok && result.value.params.model
  })
  expect(models).toEqual(['gpt-5.4', 'gpt-5.4', 'gpt-5.4'])
})

it('saving only Chat name Arguments keeps a newer model choice saved by another editor', async () => {
  const settings = useAppStore.getState().settings!
  const withModel = (model: string) =>
    normalizeSourceControlAiSettings({
      ...settings.sourceControlAi,
      modelOverridesByOperation: { conversationName: { selectedModelByAgent: { codex: model } } }
    })
  useAppStore.setState({ settings: { ...settings, sourceControlAi: withModel('gpt-5.4') } })
  render(<ChatPersistenceHarness model={settingsModel()} />)
  const naming = document.getElementById('chat-names')!
  fireEvent.click(within(naming).getByRole('button', { name: 'Advanced' }))
  fireEvent.change(screen.getByText('Arguments').nextElementSibling!, {
    target: { value: '--verbose' }
  })
  act(() =>
    useAppStore.setState(({ settings }) => ({
      settings: settings && { ...settings, sourceControlAi: withModel('gpt-5.5') }
    }))
  )
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  const saved = useAppStore.getState().settings?.sourceControlAi
  expect(saved?.actions?.conversationName?.agentArgs).toBe('--verbose')
  expect(saved?.modelOverridesByOperation?.conversationName?.selectedModelByAgent?.codex).toBe(
    'gpt-5.5'
  )
})
