// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
