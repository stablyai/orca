// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
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
} from './settings-persistence-test-fixture'
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
    model: { ...model, settings },
    interactions: controller,
    navigation: { getSectionSearchEntries: () => [getChatNamingSearchEntry()] },
    view: { isSectionMounted: () => true }
  } satisfies ChatSettingsRenderContext
  const section = renderChatSettingsSection(context)
  // The app root provides tooltips; the chat permission picker needs one.
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
  const template = screen.getByText('Command template').nextElementSibling
  const args = screen.getByText('CLI arguments').nextElementSibling
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
  fireEvent.click(screen.getByRole('combobox'))
  fireEvent.click(screen.getByRole('option', { name: 'Custom command' }))
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
