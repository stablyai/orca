// @vitest-environment happy-dom
import { readNativeChatSessionOptionCache } from '../native-chat/native-chat-session-option-cache'
import { planQueuedPaneAgentLaunch } from '../../../../main/ipc/pty/pane-agent-launch.test-fixture'
import type { RunSourceControlAgentActionStartArgs } from './runSourceControlAgentActionStart'
import type { PtySpawnIpcArgs } from '../../../../main/ipc/pty/ipc/spawn-types'
import { makeWorktree, makeTerminalTab } from '@/store/slices/worktrees-slice-test-fixtures'
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
import { resolveSourceControlActionRecipe } from '../../../../shared/source-control-ai-operation-policy'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../../../shared/tui-agent-startup'
import { tokenizeStartupCommand } from '../../../../shared/tui-agent-startup-shell'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: () => null },
  webContents: { fromId: () => null },
  ipcMain: { on() {}, removeListener() {} },
  app: { getPath: () => '/synthetic' }
}))
const execution = vi.hoisted(() => ({
  started: undefined as ((id: string | null) => void) | undefined
}))
vi.mock('@/lib/agent-launch-pane-start', () => ({
  awaitAgentLaunchPaneStart: () =>
    new Promise<string | null>((resolve) => {
      execution.started = resolve
    })
}))
vi.mock('@/lib/launch-agent-tab-prompt-paste', () => ({
  pasteAgentLaunchPromptOnceReady: async ({
    launchPty
  }: {
    launchPty: Promise<string | null>
  }) => ({ delivered: !!(await launchPty), failureNotified: false })
}))
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
          defaultSurface: model.rows.some((row) => row.agent === agent && row.kind === 'chat')
            ? 'chat'
            : 'terminal',
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

it.each([
  { agentId: null, agentArgs: undefined },
  { agentId: null, agentArgs: '' },
  { agentId: 'claude', agentArgs: undefined },
  { agentId: 'claude', agentArgs: '' }
] as const)(
  'hydrates old choice-free $agentId Args $agentArgs through disclosure or explicit Use, Save, Settings and final startup',
  async ({ agentId, agentArgs }) => {
    const old = { agentId, ...(agentArgs !== undefined ? { agentArgs } : {}) }
    const compiled: ReturnType<typeof buildAgentStartupPlan>[] = []
    const start = vi.fn<NonNullable<RunSourceControlAgentActionStartArgs['onStart']>>(
      async (request) => {
        expect(request.agent).toBe('claude')
        expect(request.agentArgs).toBe(agentArgs)
        const inputs = resolveAgentStartupPlanInputs({
          agent: request.agent,
          settings: useAppStore.getState().settings!,
          platform: 'darwin',
          isRemote: false,
          shell: 'posix',
          ...(request.agentArgs !== undefined ? { agentArgs: request.agentArgs } : {}),
          sessionOptions: request.sessionOptions
        })
        compiled.push(
          buildAgentStartupPlan({ ...inputs, prompt: '', allowEmptyPromptLaunch: true })
        )
        return true
      }
    )
    const f = mountSourceDialog(old, old, undefined, start)
    act(() =>
      useAppStore.setState(({ settings }) => ({
        settings: {
          ...settings!,
          nativeChatProviders: {},
          agentDefaultArgs: { claude: '--verbose' },
          agentPermissionDefault: 'own',
          agentLaunchChoices: { claude: { model: 'opus', options: { effort: 'high' } } }
        }
      }))
    )
    const read = () =>
      resolveSourceControlActionRecipe({
        settings: useAppStore.getState().settings!,
        repo: useAppStore.getState().repos[0],
        actionId: 'resolveConflicts'
      })
    const before = read()
    expect(before.agentArgs).toBe(agentArgs)
    expect(Object.hasOwn(before, 'agentArgs')).toBe(agentArgs !== undefined)
    expect(before.launchPreferences).toBeUndefined()
    const user = userEvent.setup()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Select agent' })).toHaveProperty('disabled', false)
    )
    await user.click(screen.getByRole('button', { name: 'Select agent' }))
    await user.click(screen.getByRole('button', { name: 'Configure Claude' }))
    if (agentId === null) {
      fireEvent.keyDown(screen.getByRole('button', { name: 'Use' }), { key: 'Escape' })
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(f.controller.recipe.agentId).toBeNull()
      expect(f.persist).not.toHaveBeenCalled()
    } else {
      await user.click(screen.getByRole('button', { name: 'Use' }))
    }
    act(() => f.controller.onSaveAgentDefaultChange('repo'))
    await user.click(screen.getByRole('button', { name: /^(Save & start agent|Start agent)$/ }))
    await waitFor(() => expect(start).toHaveBeenCalledOnce())
    expect(read()).toEqual(before)
    const own = useAppStore.getState().repos[0].sourceControlAi?.actionOverrides?.resolveConflicts
    expect(own).toMatchObject(old)
    for (const key of [
      'argumentChoices',
      'launchPreferences',
      'launchPreferencesYieldToAgentArgs'
    ]) {
      expect(Object.hasOwn(own!, key)).toBe(false)
    }
    expect(Object.hasOwn(own!, 'agentArgs')).toBe(agentArgs !== undefined)
    expect(compiled).toHaveLength(1)
    expect(compiled[0]?.launchCommand).toBe(
      `claude ${agentArgs === undefined ? "'--verbose' " : ''}'--model' 'opus' '--effort' 'high'`
    )
    expect(compiled[0]?.sessionOptions).toEqual({ model: 'opus', effort: 'high' })
    expect(compiled[0]?.launchConfig).toEqual({
      agentCommand: agentArgs === undefined ? "claude '--verbose'" : 'claude',
      agentArgs: agentArgs ?? '--verbose',
      agentEnv: {}
    })
    expect(f.persist).toHaveBeenCalledOnce()
  }
)

it.each([true, false] as const)(
  'executes accepted Customize Fast=%s through the actual queued pane intent and host compiler',
  async (fast) => {
    const f = mountSourceDialog(
      {
        agentId: 'claude',
        surface: 'terminal',
        agentArgs: '--verbose',
        commandInputTemplate: '{basePrompt}'
      },
      {},
      undefined,
      undefined,
      'repo',
      { worktreeId: 'wt-fast', promptDelivery: 'submit-after-ready', launchPlatform: 'darwin' }
    )
    const settings = useAppStore.getState().settings!
    const createTab = vi.fn<typeof initial.createTab>((_worktree, _group, _command, options) => {
      const id = options?.id ?? 'missing'
      if (!options?.pendingStartup?.agentLaunch || !options.initialLeafId) {
        throw new Error('Missing production pane request')
      }
      planned = planQueuedPaneAgentLaunch(
        options.pendingStartup.agentLaunch,
        useAppStore.getState().settings!,
        { worktreeId: 'wt-fast', tabId: id, leafId: options.initialLeafId }
      )
      void planned.then(() => execution.started?.('pty-fast'))
      return makeTerminalTab({ id, worktreeId: 'wt-fast' })
    })
    let planned: Promise<PtySpawnIpcArgs> | undefined
    act(() =>
      useAppStore.setState({
        createTab,
        worktreesByRepo: {
          [f.repo.id]: [
            makeWorktree({
              id: 'wt-fast',
              repoId: f.repo.id,
              path: '/synthetic/project',
              hostId: 'local'
            })
          ]
        },
        settings: {
          ...settings,
          nativeChatProviders: {},
          agentLaunchChoices: {
            claude: { model: 'opus', options: { effort: 'low', fastMode: !fast } }
          },
          agentDefaultArgs: {
            claude: `--settings '{"fastMode":${!fast},"theme":"light"}' --add-dir defaults`
          },
          agentDefaultEnv: { claude: { CUSTOM_ENV: 'kept' } }
        }
      })
    )
    const user = userEvent.setup()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Select agent' })).toHaveProperty('disabled', false)
    )
    await user.click(screen.getByRole('button', { name: 'Select agent' }))
    await user.click(screen.getByRole('button', { name: 'Configure Claude' }))
    if (!screen.queryByRole('textbox', { name: 'Arguments' })) {
      await user.click(screen.getByRole('button', { name: 'Toggle Arguments' }))
    }
    fireEvent.change(screen.getByRole('textbox', { name: 'Arguments' }), {
      target: {
        value: `--model private/sonnet --effort high --permission-mode acceptEdits --settings '{"theme":"dark","sibling":7}' --verbose`
      }
    })
    fireEvent.blur(screen.getByRole('textbox', { name: 'Arguments' }))
    const toggle = screen.getByRole('switch')
    if ((toggle.getAttribute('aria-checked') === 'true') === fast) {
      await user.click(toggle)
    }
    await user.click(toggle)
    await user.click(screen.getByRole('button', { name: 'Use' }))
    act(() => f.controller.onSaveAgentDefaultChange('repo'))
    await user.click(screen.getByRole('button', { name: 'Save & start agent' }))
    await waitFor(() => expect(createTab).toHaveBeenCalledOnce())
    const final = await planned
    await waitFor(() => expect(f.persist).toHaveBeenCalledOnce())
    expect(final?.launchAgent).toBe('claude')
    const parsed = tokenizeStartupCommand(final?.command ?? '', 'posix')
    expect(parsed.ok && parsed.tokens).toEqual([
      'claude',
      '--settings',
      JSON.stringify({ theme: 'dark', sibling: 7, fastMode: fast }),
      '--verbose',
      '--model',
      'private/sonnet',
      '--effort',
      'high',
      '--permission-mode',
      'acceptEdits'
    ])
    expect(final?.launchConfig).toEqual({
      agentCommand: `claude '--settings' '${JSON.stringify({ theme: 'dark', sibling: 7, fastMode: fast })}' '--verbose' '--permission-mode' 'acceptEdits'`,
      agentArgs: `'--settings' '${JSON.stringify({ theme: 'dark', sibling: 7, fastMode: fast })}' '--verbose' '--permission-mode' 'acceptEdits'`,
      agentEnv: { CUSTOM_ENV: 'kept' }
    })
    expect(final?.env).toMatchObject({
      CUSTOM_ENV: 'kept',
      ORCA_AGENT_LAUNCH_TOKEN: expect.any(String)
    })
    const saved = useAppStore.getState().repos[0].sourceControlAi?.actionOverrides?.resolveConflicts
    expect(saved?.agentArgs).toBe(`--settings '{"theme":"dark","sibling":7}' --verbose`)
    expect(saved?.commandInputTemplate).toBe('{basePrompt}')
    expect(saved?.launchPreferences?.modelSelection?.options?.fastMode).toEqual({
      agentId: 'claude',
      value: String(fast)
    })
    const tabId = createTab.mock.calls[0][3]!.id!
    expect(
      readNativeChatSessionOptionCache(tabId)?.valuesByModel['private/sonnet'].fastMode
    ).toEqual({ value: String(fast), source: 'applied' })
    if (fast) {
      const captured = createTab.mock.calls[0][3]!.pendingStartup!.agentLaunch!.launch
      const { EVERY_AGENT_CHAT } =
        await import('../../../../shared/native-chat/every-agent-chat.test-fixture')
      const { RUNTIME_CAPABILITIES } = await import('../../../../shared/protocol-version')
      const { planAgentSessionLaunch } = await import('@/lib/agent-session-launch-plan')
      const { openDeclinedTerminal } = await import('@/lib/structured-agent-session-action-launch')
      setLocalRuntimeCapabilitiesForTests(RUNTIME_CAPABILITIES)
      act(() =>
        useAppStore.setState(({ settings }) => ({
          settings: { ...settings!, nativeChatProviders: EVERY_AGENT_CHAT }
        }))
      )
      const plan = planAgentSessionLaunch(useAppStore.getState(), {
        requestId: 'independent-fallback',
        agent: 'claude',
        workspace: { kind: 'git-worktree', worktreeId: 'wt-fast' },
        launchOptions: captured.sessionOptions,
        chatLaunchOptions: {},
        prompt: 'Fix',
        promptDelivery: 'submit-after-ready'
      })
      expect(plan.route).toBe('structured-native-chat')
      const fallback = await openDeclinedTerminal(
        {
          plan,
          hooks: {},
          declinedTerminal: { agentArgs: captured.agentArgs, launchPlatform: 'darwin' }
        },
        'wt-fast',
        { kind: 'local' }
      )
      expect(fallback.opened).toBe(true)
      expect(createTab).toHaveBeenCalledTimes(2)
      const terminal = await planned
      expect(terminal?.command).toBe(final?.command)
      expect(terminal?.launchConfig).toEqual(final?.launchConfig)
      expect(terminal?.launchConfig).not.toHaveProperty('chatSessionOptions')
      expect(terminal?.launchConfig).not.toHaveProperty('chatLaunchOptions')
    }
    const savedBytes = structuredClone(saved)
    const creates = createTab.mock.calls.length
    f.view.unmount()
    const reopened = f.mount()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^(Save & start agent|Start agent)$/ })
      ).toHaveProperty('disabled', false)
    )
    await user.click(screen.getByRole('button', { name: /^(Save & start agent|Start agent)$/ }))
    await waitFor(() => expect(createTab).toHaveBeenCalledTimes(creates + 1))
    const replayed = await planned
    expect(replayed?.command).toBe(final?.command)
    expect(replayed?.launchConfig).toEqual(final?.launchConfig)
    expect(
      useAppStore.getState().repos[0].sourceControlAi?.actionOverrides?.resolveConflicts
    ).toEqual(savedBytes)
    reopened.unmount()
  }
)

it.each(['claude', 'codex'] as const)(
  'writes only explicit route events in actual %s Customize and preserves the saved tuple on reopen',
  async (agent) => {
    const recipe = {
      agentId: agent,
      surface: 'terminal' as const,
      agentArgs: '--add-dir "two words"',
      commandInputTemplate: 'CURRENT {basePrompt}',
      launchPreferences: {
        agentId: agent,
        modelSelection: {
          base: 'default' as const,
          model: { agentId: agent, value: agent === 'claude' ? 'sonnet' : 'gpt-5.5' },
          options: { effort: { agentId: agent, value: 'high' } }
        },
        permissionMode: 'own' as const
      }
    }
    const f = mountSourceDialog(recipe, recipe)
    act(() =>
      useAppStore.setState(({ settings }) => ({
        settings: { ...settings!, nativeChatProviders: {} }
      }))
    )
    const user = userEvent.setup()
    const open = async () => {
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Select agent' })).toHaveProperty(
          'disabled',
          false
        )
      )
      await user.click(screen.getByRole('button', { name: 'Select agent' }))
    }
    await open()
    await user.click(
      screen.getByRole('menuitem', { name: new RegExp(agent === 'claude' ? '^Claude' : '^Codex') })
    )
    expect(f.controller.recipe).toMatchObject(recipe)
    await open()
    await user.click(
      screen.getByRole('button', { name: `Configure ${agent === 'claude' ? 'Claude' : 'Codex'}` })
    )
    await user.click(screen.getByRole('button', { name: 'Use' }))
    expect(f.controller.recipe).toMatchObject(recipe)
    await user.click(screen.getByRole('radio', { name: 'Chat', exact: true }))
    expect(f.controller.recipe).toMatchObject({ ...recipe, surface: 'chat' })
    await open()
    await user.click(
      screen.getByRole('menuitem', { name: new RegExp(agent === 'claude' ? '^Claude' : '^Codex') })
    )
    expect(f.controller.recipe).toMatchObject({ ...recipe, surface: 'chat' })
    await user.click(screen.getByRole('radio', { name: 'Terminal', exact: true }))
    expect(f.controller.recipe).toMatchObject(recipe)
    await user.click(screen.getByRole('radio', { name: 'Chat', exact: true }))
    act(() => f.controller.onSaveAgentDefaultChange('repo'))
    await user.click(screen.getByRole('button', { name: 'Save & start agent' }))
    await waitFor(() => expect(f.persist).toHaveBeenCalledOnce())
    const saved = useAppStore.getState().repos[0].sourceControlAi?.actionOverrides?.resolveConflicts
    expect(saved).toEqual({ ...recipe, surface: 'chat' })
    f.view.unmount()
    const reopened = f.mount()
    expect(f.controller.recipe).toMatchObject({ ...recipe, surface: 'chat' })
    reopened.unmount()
  }
)
