// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { ChatNamingSetting } from './ChatNamingSetting'
import { CommitMessageAiPane } from './CommitMessageAiPane'
import { useSettingsInteractionController } from './use-settings-interaction-controller'
import {
  persist,
  settingsModel,
  type SettingsPersistenceModel
} from './settings-persistence-test-fixture'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control-ai'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

beforeEach(() => useAppStore.setState({ settingsSearchQuery: '' }))

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
        writeSourceControlAiSettings={controller.writeSourceControlAiSettings}
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
