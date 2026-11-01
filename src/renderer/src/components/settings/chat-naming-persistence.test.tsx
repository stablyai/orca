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
  resolveSourceControlAiForOperation
} from '../../../../shared/source-control-ai'
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
