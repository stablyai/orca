// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { ChatNamingSetting } from './ChatNamingSetting'
import { CommitMessageAiPane } from './CommitMessageAiPane'
import { useSettingsInteractionController } from './use-settings-interaction-controller'
import {
  persist,
  settingsModel,
  type SettingsPersistenceModel
} from './__fixtures__/settings-persistence-test-fixture'
import * as selection from '../../../../shared/source-control-launch-agent-selection'
import * as lifts from '../../../../shared/source-control-action-permission-lift'
import * as shell from '../../../../shared/tui-agent-startup-shell'
import { TooltipProvider } from '../ui/tooltip'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../shared/source-control-ai'

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

it('global owner: bounded controlled edits, failed/same selection and no-op save', async () => {
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
      experimentalNativeChat: false,
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
  const input = row.getByRole('textbox', { name: 'Arguments' })
  await waitFor(() => expect(input).toHaveProperty('disabled', false))
  summary.mockClear()
  lift.mockClear()
  const inputWork: number[][] = []
  for (const n of [32, 320]) {
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
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(lift).toHaveBeenCalledTimes(1)
  let reject = (_error: Error): void => {}
  persist.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail
      })
  )
  fireEvent.click(row.getAllByRole('combobox')[0])
  fireEvent.click(screen.getByRole('option', { name: 'Codex' }))
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
  // Actual global writer publishes only after success; failed selection must retain this later edit.
  fireEvent.change(input, { target: { value: '--verbose newer' } })
  await act(async () => reject(new Error('disk unavailable')))
  await waitFor(() =>
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/Failed to/),
      expect.any(Error)
    )
  )
  expect(input).toHaveProperty('value', '--verbose newer')
  fireEvent.click(row.getAllByRole('combobox')[0])
  fireEvent.click(screen.getByRole('option', { name: 'Claude' }))
  expect(row.getByRole('button', { name: /Remove --dangerously/ })).toBeDefined()
  persist.mockRejectedValueOnce(new Error('Save disk unavailable'))
  fireEvent.click(row.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(console.error).toHaveBeenCalledWith(new Error('Save disk unavailable'))
  )
  fireEvent.click(row.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(persist).toHaveBeenCalledTimes(3))
  expect(useAppStore.getState().settings?.sourceControlAi?.actions?.fixChecks).toMatchObject({
    agentId: 'claude',
    agentArgs: '--verbose newer',
    launchPreferences: {
      agentId: 'claude',
      model: 'sonnet',
      options: { effort: 'high' },
      permissionMode: 'full-access'
    }
  })
  await waitFor(() =>
    expect(row.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  )
  expect(summary).not.toHaveBeenCalled()
})
