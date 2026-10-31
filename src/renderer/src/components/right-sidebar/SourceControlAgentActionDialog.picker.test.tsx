// @vitest-environment happy-dom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { formatAgentTypeLabel } from '../../../../shared/agent-type-label'
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
          label: formatAgentTypeLabel(agent),
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

it.each(['global', 'repo'] as const)(
  'keeps pending Customize setup over template-only edits and saves current %s metadata',
  async (scope) => {
    const { i18n } = await import('@/i18n/i18n')
    const { default: spanish } = await import('@/i18n/locales/es.json')
    const previous = structuredClone(i18n.getResourceBundle('es', 'translation') ?? {})
    i18n.addResourceBundle('es', 'translation', spanish, true, true)
    await i18n.changeLanguage('en')
    try {
      const mounted = mountSourceDialog(
        {
          agentId: 'claude',
          commandInputTemplate: 'Old global',
          agentArgs: '--saved',
          launchPreferences: {
            agentId: 'claude',
            model: 'sonnet',
            options: { effort: 'high' },
            permissionMode: 'ask'
          }
        },
        {
          agentId: 'claude',
          commandInputTemplate: 'Old repo',
          agentArgs: '--saved',
          launchPreferences: {
            agentId: 'claude',
            model: 'sonnet',
            options: { effort: 'high' },
            permissionMode: 'ask'
          }
        },
        undefined,
        undefined,
        scope
      )
      const open = async () => {
        const trigger = screen.getByRole('button', { name: 'Select agent' })
        await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
        fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
        fireEvent.click(await screen.findByRole('button', { name: 'Configure Claude' }))
        const toggle = screen.getByRole('button', { name: 'Toggle Arguments' })
        if (!screen.queryByRole('textbox', { name: 'Arguments' })) {
          fireEvent.click(toggle)
        }
      }
      await open()
      fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
        target: { value: '--model claude-sonnet-5-5 --accepted' }
      })
      fireEvent.blur(screen.getByRole('textbox', { name: 'Arguments' }))
      fireEvent.click(screen.getByRole('radio', { name: 'High' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
        target: { value: '--latest-pending' }
      })
      const search = screen.getByLabelText('Search models')
      fireEvent.change(search, { target: { value: 'son' } })
      expect(screen.getByRole('radio', { name: 'High' }).getAttribute('aria-checked')).toBe('true')
      const permission = screen.getByRole('button', { name: 'Claude permissions' })
      const accepted = mounted.controller.recipe
      const pendingInput = screen.getByRole('textbox', { name: 'Arguments' })
      await act(() => i18n.changeLanguage('es'))
      expect(document.querySelector('button[aria-label="Seleccionar agente"]')).toBeTruthy()
      expect(screen.getByRole('textbox', { name: 'Argumentos' })).toBe(pendingInput)
      expect(pendingInput).toHaveProperty('value', '--latest-pending')
      expect(screen.getByRole('button', { name: 'Usar' })).toBeTruthy()
      expect(screen.getByRole('radio', { name: 'Alto' }).getAttribute('aria-checked')).toBe('true')
      expect(screen.getByRole('button', { name: 'Permisos de Claude' })).toBe(permission)
      expect(mounted.controller.recipe).toBe(accepted)
      expect(mounted.persist).not.toHaveBeenCalled()
      expect(mounted.onStart).not.toHaveBeenCalled()
      act(() =>
        i18n.addResourceBundle(
          'es',
          'translation',
          {
            agentPicker: {
              select: 'Agente actualizado',
              use: 'Aplicar actualizado',
              arguments: 'Argumentos actualizados',
              openIn: 'Abrir actualizado',
              chat: 'Conversación actualizada',
              terminal: 'Terminal actualizada'
            },
            auto: {
              components: { settings: { AgentsPane: { cfb3f35775: 'Argumentos actualizados' } } }
            }
          },
          true,
          true
        )
      )
      expect(document.querySelector('button[aria-label="Agente actualizado"]')).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Aplicar actualizado' })).toBeTruthy()
      expect(document.querySelector('[aria-label="Abrir actualizado"]')?.textContent).toContain(
        'Conversación actualizada'
      )
      expect(document.querySelector('[aria-label="Abrir actualizado"]')?.textContent).toContain(
        'Terminal actualizada'
      )
      expect(screen.getByRole('textbox', { name: 'Argumentos actualizados' })).toBe(pendingInput)
      expect(pendingInput).toHaveProperty('value', '--latest-pending')
      expect(search).toHaveProperty('value', 'son')
      expect(screen.getByRole('button', { name: /claude-sonnet-5-5/ })).toBeTruthy()
      expect(mounted.controller.recipe).toBe(accepted)
      await act(() => i18n.changeLanguage('en'))
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Arguments' }), { key: 'Escape' })
      fireEvent.keyDown(document, { key: 'Escape' })
      act(() => mounted.controller.onCommandTemplateChange('CURRENT {basePrompt}'))
      await open()
      expect(screen.getByRole('textbox', { name: 'Arguments' })).toHaveProperty(
        'value',
        '--latest-pending'
      )
      expect(screen.getByRole('button', { name: 'Remove --model claude-sonnet-5-5' })).toBeDefined()
      fireEvent.click(screen.getByRole('button', { name: 'Use' }))
      expect(mounted.controller.recipe.commandInputTemplate).toBe('CURRENT {basePrompt}')
      expect(mounted.controller.recipe.agentArgs).toBe('--latest-pending')
      await act(() => mounted.controller.handleStart())
      expect(mounted.persist).toHaveBeenCalledOnce()
      expect(mounted.persist.mock.calls[0][2].commandInputTemplate).toBe('CURRENT {basePrompt}')
      expect(mounted.onStart).toHaveBeenCalledOnce()
      expect(mounted.onStart.mock.calls[0][0].commandInput).toBe('CURRENT fix')
      expect(submittedActionStartupPlan(mounted.onStart.mock.calls[0][0])).toMatchObject({
        launchCommand: expect.stringContaining('--latest-pending')
      })
    } finally {
      cleanup()
      i18n.removeResourceBundle('es', 'translation')
      i18n.addResourceBundle('es', 'translation', previous)
      await i18n.changeLanguage('en')
    }
  }
)
