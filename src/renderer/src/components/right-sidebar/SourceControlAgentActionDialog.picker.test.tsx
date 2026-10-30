// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  agentPickerChoiceSeeds,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'
import type { NewTabAgentMenuModel } from '../tab-bar/use-new-tab-agent-menu-rows'
import {
  mountSourceDialog,
  submittedActionStartupPlan
} from './source-control-action-dialog.test-fixture'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { tokenizeStartupCommand } from '../../../../shared/tui-agent-startup-shell'

vi.mock('../agent/use-agent-launch-picker-inventory', () => ({
  useAgentLaunchPickerInventory: (_id: string | undefined, model: NewTabAgentMenuModel) =>
    model.state !== 'settled'
      ? []
      : [...new Set(model.rows.map((row) => row.agent))].map((agent): AgentPickerEntry => ({
          agent,
          label: agent === 'claude' ? 'Claude' : 'Codex',
          ownerKey: `action-${agent}`,
          rows: model.rows.filter((row) => row.agent === agent),
          surfaces: ['chat', 'terminal'],
          defaultSurface: 'chat',
          ...agentPickerChoiceSeeds(agent, useAppStore.getState().settings),
          catalog: {
            origin: 'probe',
            fetchedAt: 1,
            models: (agent === 'claude' ? ['opus', 'sonnet'] : ['o3', 'gpt-5.5']).map(
              (id, index) => ({
                id,
                label: id,
                isDefault: index === 0,
                defaultEffort: 'high',
                efforts: [
                  { value: 'low', label: 'Low' },
                  { value: 'high', label: 'High' }
                ],
                supportsFastMode: true,
                ...(agent === 'codex'
                  ? { serviceTiers: [{ value: 'priority', label: 'Fast' }] }
                  : {})
              })
            )
          }
        }))
}))
const initial = useAppStore.getState()
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
  setLocalRuntimeCapabilitiesForTests(null)
})

it.each(['claude', 'codex'] as const)(
  'edits %s in the common panel, saves and starts the resulting recipe',
  async (agent) => {
    const f = mountSourceDialog({ agentId: agent, surface: 'terminal', agentArgs: '--verbose' }, {})
    const user = userEvent.setup()
    const label = agent === 'claude' ? 'Claude' : 'Codex'
    const model = agent === 'claude' ? 'sonnet' : 'gpt-5.5'
    const trigger = screen.getByRole('button', { name: 'Select agent' })
    await waitFor(() => expect(trigger.hasAttribute('disabled')).toBe(false))
    await user.click(trigger)
    await user.click(screen.getByRole('button', { name: `Configure ${label}` }))
    await user.click(screen.getByRole('option', { name: model }))
    await user.click(screen.getByRole('radio', { name: 'Low' }))
    await user.click(screen.getByRole('button', { name: `${label} permissions` }))
    await user.click(screen.getByRole('menuitemradio', { name: /^Full access/ }))
    await user.click(
      agent === 'claude' ? screen.getByRole('switch') : screen.getByRole('radio', { name: 'Fast' })
    )
    const text = screen.queryByRole('textbox', { name: 'Arguments' })
    if (!text) {
      await user.click(screen.getByRole('button', { name: 'Toggle Arguments' }))
    }
    fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
      target: { value: '--add-dir docs' }
    })
    await user.click(screen.getByRole('button', { name: 'Use' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Arguments' })).toBeNull())
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save & start agent' }))
    )
    await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
    expect(f.onStart.mock.calls[0][0]).toMatchObject({
      agent,
      sessionOptions: {
        model,
        effort: 'low',
        permissionMode: 'full-access',
        ...(agent === 'claude' ? { fastMode: 'true' } : { serviceTier: 'priority' })
      }
    })
    expect(f.onStart.mock.calls[0][0].agentArgs).toContain('--add-dir docs')
    expect(f.persist).toHaveBeenCalledOnce()
  }
)

it.each(['global', 'repo'] as const)(
  'keeps %s Customize permission-only edits sparse through Save and Start',
  async (scope) => {
    const f = mountSourceDialog(
      { agentId: 'claude', surface: 'terminal' },
      scope === 'repo' ? { agentId: 'claude' } : {},
      undefined,
      undefined,
      scope
    )
    act(() =>
      useAppStore.setState(({ settings }) => ({
        settings: settings && { ...settings, agentDefaultArgs: { claude: '--verbose' } }
      }))
    )
    const user = userEvent.setup()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Select agent' })).toHaveProperty('disabled', false)
    )
    await user.click(screen.getByRole('button', { name: 'Select agent' }))
    await user.click(screen.getByRole('button', { name: 'Configure Claude' }))
    await user.click(screen.getByRole('button', { name: 'Claude permissions' }))
    await user.click(screen.getByRole('menuitemradio', { name: /^Ask/ }))
    await user.click(screen.getByRole('button', { name: 'Use' }))
    if (scope === 'repo') {
      act(() => f.controller.onSaveAgentDefaultChange('repo'))
    }
    await user.click(screen.getByRole('button', { name: 'Save & start agent' }))
    await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
    const saved =
      scope === 'global'
        ? useAppStore.getState().settings?.sourceControlAi?.actions?.resolveConflicts
        : useAppStore.getState().repos[0].sourceControlAi?.actionOverrides?.resolveConflicts
    expect(saved?.agentArgs).toBeUndefined()
    expect(saved?.launchPreferences?.permissionMode).toBe('ask')
  }
)

it.each(['global', 'repo'] as const)(
  'accepts only the latest %s Customize buffer through Save, reopen and terminal startup',
  async (scope) => {
    const parent = {
      agentId: 'claude' as const,
      surface: 'terminal' as const,
      agentArgs: '--verbose',
      launchPreferences: { agentId: 'claude' as const, permissionMode: 'ask' as const }
    }
    const f = mountSourceDialog(
      parent,
      { commandInputTemplate: '{basePrompt}' },
      undefined,
      undefined,
      scope
    )
    const user = userEvent.setup()
    const configure = async () => {
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Select agent' })).toHaveProperty(
          'disabled',
          false
        )
      )
      await user.click(screen.getByRole('button', { name: 'Select agent' }))
      await user.click(screen.getByRole('button', { name: 'Configure Claude' }))
      if (!screen.queryByRole('textbox', { name: 'Arguments' })) {
        await user.click(screen.getByRole('button', { name: 'Toggle Arguments' }))
      }
    }
    await configure()
    const input = screen.getByRole('textbox', { name: 'Arguments' })
    for (const value of ['--model s', '--model sonnet --effort high', '--add-dir docs']) {
      fireEvent.change(input, { target: { value } })
    }
    await user.click(screen.getByRole('button', { name: 'Use' }))
    act(() => f.controller.onSaveAgentDefaultChange(scope))
    await user.click(screen.getByRole('button', { name: 'Save & start agent' }))
    await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
    const state = useAppStore.getState()
    const saved =
      scope === 'global'
        ? state.settings?.sourceControlAi?.actions?.resolveConflicts
        : state.repos[0].sourceControlAi?.actionOverrides?.resolveConflicts
    expect(saved?.agentArgs).toBe('--add-dir docs')
    expect(saved?.launchPreferences?.model).toBeUndefined()
    expect(saved?.launchPreferences?.options?.effort).toBeUndefined()
    if (scope === 'repo') {
      expect(state.settings?.sourceControlAi?.actions?.resolveConflicts).toEqual(parent)
    }
    const submitted = f.onStart.mock.calls[0][0]
    expect(submitted.agentArgs).toContain('--add-dir docs')
    expect(submitted.sessionOptions?.model).toBeUndefined()
    expect(submitted.sessionOptions?.effort).toBeUndefined()
    const startup = submittedActionStartupPlan(submitted)
    expect(startup).not.toBeNull()
    if (!startup) {
      throw new Error('Expected terminal startup')
    }
    const command = tokenizeStartupCommand(startup.launchCommand, 'posix')
    expect(command.ok).toBe(true)
    if (!command.ok) {
      throw new Error(command.error)
    }
    expect(command.tokens).toEqual([
      'claude',
      '--add-dir',
      'docs',
      '--permission-mode',
      'default',
      'fix'
    ])

    f.view.unmount()
    const reopened = f.mount()
    await configure()
    expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty(
      'value',
      '--add-dir docs'
    )
    expect(screen.queryByRole('button', { name: 'Remove --model sonnet' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Use' }))
    expect(f.persist).toHaveBeenCalledOnce()
    reopened.unmount()
  }
)
