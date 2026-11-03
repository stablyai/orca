// @vitest-environment happy-dom
import type { ComponentProps } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import {
  persist,
  runtimeCall,
  settingsModel,
  type SettingsPersistenceModel
} from '../__fixtures__/settings-persistence-test-fixture'
import { CommitMessageAiPane } from './CommitMessageAiPane'
import { useSettingsInteractionController } from '../page/use-settings-interaction-controller'
import { TooltipProvider } from '@/components/ui/tooltip'
import { RUNTIME_CAPABILITIES } from '../../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../../shared/source-control-ai'
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), dismiss: vi.fn() }
}))
beforeEach(() => useAppStore.setState({ settingsSearchQuery: '' }))
afterEach(() => setLocalRuntimeCapabilitiesForTests(null))
function GitPersistenceHarness({ model }: { model: SettingsPersistenceModel }) {
  const settings = useAppStore((state) => state.settings)
  const controller = useSettingsInteractionController(model)
  if (!settings) {
    throw new Error('Settings fixture is missing')
  }
  return (
    <CommitMessageAiPane
      settings={settings}
      updateSettings={model.updateSettings}
      writeSourceControlAiSettings={controller.writeSourceControlAiSettingsOrThrow}
    />
  )
}

it.each(['global', 'repo'] as const)(
  'retains %s pending template and setup through the real Agents dialog and Save',
  async (scope) => {
    Object.assign(window.api, { platform: { get: () => ({ platform: 'darwin' }) } })
    const mutate = runtimeCall.getMockImplementation()!
    runtimeCall.mockImplementation((request) =>
      request.method === 'agentSession.agents'
        ? Promise.resolve({ ok: true, result: { agents: [] } })
        : mutate(request)
    )
    setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES)
    const { TEST_REPO } = await import('@/store/slices/worktrees-slice-test-fixtures')
    const { RepositorySourceControlAiSection } =
      await import('../repository/source-control/RepositorySourceControlAiSection')
    const recipe = {
      agentId: 'claude' as const,
      surface: 'terminal' as const,
      commandInputTemplate: 'OLD {basePrompt}'
    }
    useAppStore.setState(({ settings }) => ({
      settings: {
        ...settings!,
        nativeChatProviders: {},
        sourceControlAi: normalizeSourceControlAiSettings({
          ...getDefaultSourceControlAiSettings(),
          enabled: true,
          actions: { fixChecks: recipe }
        })
      },
      repos: [{ ...TEST_REPO, sourceControlAi: { actionOverrides: { fixChecks: recipe } } }],
      localDetectedAgentIdsByContext: { host: ['claude', 'codex'] }
    }))
    const updateRepo = vi.fn(async (id, patch) => {
      useAppStore.setState((state) => ({
        repos: state.repos.map((repo) => (repo.id === id ? { ...repo, ...patch } : repo))
      }))
      return true
    }) satisfies ComponentProps<typeof RepositorySourceControlAiSection>['updateRepo']
    function Owner() {
      const repo = useAppStore((state) => state.repos[0])
      return scope === 'repo' ? (
        <RepositorySourceControlAiSection repo={repo} updateRepo={updateRepo} />
      ) : (
        <GitPersistenceHarness model={settingsModel()} />
      )
    }
    render(
      <TooltipProvider>
        <Owner />
      </TooltipProvider>
    )
    const rowElement = screen.getByText('Broken checks fixes').closest<HTMLElement>('.rounded-md')!
    const row = within(rowElement)
    const template = rowElement.querySelector('textarea')!
    fireEvent.change(template, { target: { value: 'PENDING {basePrompt}' } })
    const open = async () => {
      const trigger = row.getByRole('button', { name: 'Select agent' })
      await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    }
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
    const args = screen.getByRole('textbox', { name: 'Arguments' })
    await waitFor(() => expect(args).toHaveProperty('disabled', false))
    fireEvent.change(args, { target: { value: '--debug' } })
    fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Agent settings…' }))
    const agents = await screen.findByRole('dialog', { name: 'Agents' })
    expect(within(agents).getAllByRole('switch').length).toBeGreaterThan(0)
    fireEvent.click(within(agents).getByRole('button', { name: 'Close' }))
    expect(template.isConnected).toBe(true)
    expect(template.value).toBe('PENDING {basePrompt}')
    expect(persist).not.toHaveBeenCalled()
    expect(updateRepo).not.toHaveBeenCalled()
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
    expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty('value', '--debug')
    fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }))
    fireEvent.click(row.getByRole('button', { name: 'Save' }))
    const read = () =>
      scope === 'global'
        ? useAppStore.getState().settings?.sourceControlAi?.actions?.fixChecks
        : useAppStore.getState().repos[0].sourceControlAi?.actionOverrides?.fixChecks
    await waitFor(() =>
      expect(read()).toEqual({
        ...recipe,
        agentArgs: '--debug',
        commandInputTemplate: 'PENDING {basePrompt}'
      })
    )
  }
)

it.each([false, true])(
  'preserves stored Terminal on single-mode acceptance with surface persistence %s',
  async (capable) => {
    const inventory = await import('../../agent/use-agent-launch-picker-inventory')
    const { SourceControlActionAgentPicker } = await import('./SourceControlActionAgentPicker')
    setLocalRuntimeCapabilitiesForTests(capable ? RUNTIME_CAPABILITIES : [])
    useAppStore.setState(({ settings }) => ({
      settings: { ...settings!, nativeChatProviders: {} },
      localDetectedAgentIdsByContext: { host: ['claude'] }
    }))
    vi.spyOn(inventory, 'useAgentLaunchPickerInventory').mockReturnValue([
      {
        agent: 'claude',
        label: 'Claude',
        rows: [{ agent: 'claude', kind: 'cli' }],
        surfaces: ['terminal'],
        defaultSurface: 'terminal',
        terminal: {},
        structured: {},
        catalog: { origin: 'unknown' }
      }
    ])
    const onPick = vi.fn()
    const onSetupPick = vi.fn()
    render(
      <TooltipProvider>
        <SourceControlActionAgentPicker
          agent="claude"
          surface="terminal"
          onPick={onPick}
          onSetupPick={onSetupPick}
        />
      </TooltipProvider>
    )
    const trigger = screen.getByRole('button', { name: 'Select agent' })
    await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
    fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }))
    expect(onPick).not.toHaveBeenCalled()
    expect(onSetupPick).not.toHaveBeenCalled()
  }
)
