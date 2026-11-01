// @vitest-environment happy-dom

import {
  commitSourceControlActionArguments,
  editSourceControlActionArguments
} from '../../../../shared/source-control-action-selection'
import {
  captureSourceControlActionSelection,
  resolveSourceControlActionRecipe
} from '../../../../shared/source-control-ai-operation-policy'
import { projectSourceControlActionLaunch } from '../../../../shared/source-control-action-launch-preferences'
import { structuredLaunchRequestedOptions } from '../../../../shared/native-chat/input/native-chat-session-option-defaults'
import { liftActionPermissionArgs } from '../../../../shared/source-control-action-permission-lift'
import type { Repo } from '../../../../shared/repo-types'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { clearHostAgentMenuSettingsForTests } from '../settings/use-host-agent-launch-preferences'
import type { SourceControlActionRecipe } from '../../../../shared/source-control-ai-actions'
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useSourceControlAgentActionDialog } from './useSourceControlAgentActionDialog'
import {
  mountSourceDialog,
  freshDialogRecipe,
  pickDialogSaveTarget,
  submittedActionStartupPlan,
  renderDialog,
  pickDialogAgent,
  type SaveAction
} from './source-control-action-dialog.test-fixture'

const initialState = useAppStore.getState()
afterEach(() => {
  cleanup()
  clearHostAgentMenuSettingsForTests()
  useAppStore.setState(initialState, true)
  setLocalRuntimeCapabilitiesForTests(null)
})

it('starts and saves a live pick from the unified picker, keeping the agent-bound model', async () => {
  const { result, onStart, onSaveAgentDefault, launchPreferences } = renderDialog(true)
  await waitFor(() => expect(result.current.canStart).toBe(true))
  // An untouched default recipe stays the default and saves no surface of its own.
  expect(result.current.selectedAgent).toBe('claude')
  expect(result.current.recipe).toMatchObject({ agentId: null, launchPreferences })
  expect(result.current.agentArgsApply).toBe(false)

  act(() => result.current.surfaceRows.onPick('codex', 'terminal'))
  expect(result.current.recipe).toMatchObject({ agentId: 'codex', surface: 'terminal' })
  expect(result.current.recipe.launchPreferences).toEqual(launchPreferences)
  expect(result.current.surfaceRows.selection.cli).toBe(true)
  expect(result.current.agentArgsApply).toBe(true)
  await act(() => result.current.handleStart())

  expect(onStart).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'codex',
      launchChoice: expect.objectContaining({
        route: 'terminal-tui',
        requestedSurface: 'terminal'
      })
    })
  )
  expect(onSaveAgentDefault).toHaveBeenCalledWith(
    { type: 'global' },
    'resolveConflicts',
    expect.objectContaining({ agentId: 'codex', surface: 'terminal' })
  )

  act(() => result.current.surfaceRows.onPick('claude', 'chat'))
  expect(result.current.recipe).toMatchObject({ agentId: 'claude', surface: 'chat' })
  expect(result.current.recipe.launchPreferences).toBeUndefined()
  expect(result.current.agentArgsApply).toBe(false)
})

it('leaves an untouched saved surface in the draft but omits it when saving to an older action host', async () => {
  const { result, onSaveAgentDefault } = renderDialog(true, false, {
    agentId: 'codex',
    surface: 'terminal'
  })
  await waitFor(() => expect(result.current.canStart).toBe(true))
  expect(result.current.recipe.surface).toBe('terminal')
  expect(result.current.agentArgsApply).toBe(true)
  act(() => result.current.onCommandTemplateChange('edited {basePrompt}'))
  await act(() => result.current.handleStart())
  const saved = onSaveAgentDefault.mock.calls[0]?.[2]
  expect(saved).not.toHaveProperty('surface')
  expect(saved).not.toHaveProperty('agentArgs')
  expect(result.current.recipe.surface).toBe('terminal')
})

it('allows replacing an unavailable saved agent without making it launchable', async () => {
  const f = renderDialog(false, true, { agentId: 'codex', agentArgs: '' })
  await act(async () =>
    useAppStore.setState({
      detectedAgentIds: ['claude'],
      localDetectedAgentIdsByContext: { host: ['claude'] }
    })
  )
  expect(f.result.current.surfaceRows.selection.ready).toBe(true)
  expect(f.result.current.canStart).toBe(false)
  expect(f.result.current.recipe.agentId).toBe('codex')
  expect(f.onStart).not.toHaveBeenCalled()
  act(() => f.result.current.surfaceRows.onPick('claude', 'terminal'))
  await waitFor(() => expect(f.result.current.canStart).toBe(true))
})

const hostRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: hostRpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
it.each(['codex', null] as const)(
  'uses the offered host identity for delivery and scope, preserving authored %s',
  async (agentId) => {
    const reply = Promise.withResolvers<{
      settings: ReturnType<typeof projectAgentLaunchSettings>
    }>()
    hostRpc.mockReturnValue(reply.promise)
    const settings = {
      ...getDefaultSettings('/tmp/host-action'),
      defaultTuiAgent: 'opencode' as const,
      disabledTuiAgents: ['codex' as const],
      nativeChatProviders: { claude: false, codex: false }
    }
    const recipe = {
      agentId,
      surface: 'terminal' as const,
      agentArgs: '--model chosen',
      launchPreferences: { agentId: 'codex' as const, model: 'chosen' }
    }
    const repo: Repo = {
      ...TEST_REPO,
      executionHostId: 'runtime:alpha',
      sourceControlAi: {
        actionOverrides: {
          resolveConflicts: {
            agentId: 'codex' as const,
            launchPreferences: recipe.launchPreferences
          }
        }
      }
    }
    useAppStore.setState({
      settings,
      repos: [repo],
      worktreesByRepo: {
        [repo.id]: [makeWorktree({ id: 'wt', repoId: repo.id, hostId: 'runtime:alpha' })]
      },
      runtimeDetectedAgentIds: {
        [getRuntimeAgentInventoryKey('alpha', 'wt')]: ['claude', 'codex', 'opencode']
      },
      ensureRuntimeDetectedAgents: vi.fn().mockResolvedValue(['claude', 'codex', 'opencode']),
      refreshRuntimeDetectedAgents: vi.fn().mockResolvedValue(['claude', 'codex', 'opencode'])
    })
    const onStart = vi.fn().mockResolvedValue(true)
    const onSaveAgentDefault = vi.fn()
    const view = renderHook(() =>
      useSourceControlAgentActionDialog({
        open: true,
        initialRecipe: recipe,
        onOpenChange: vi.fn(),
        actionId: 'resolveConflicts',
        title: '',
        description: '',
        baseCommandInput: 'fix',
        launchSource: 'source_control_recovery',
        worktreeId: 'wt',
        repoId: repo.id,
        connectionId: null,
        onStart,
        onSaveAgentDefault
      })
    )
    expect(view.result.current.canStart).toBe(false)
    expect(view.result.current.saveTargetValue).toBe('repo')
    act(() => view.result.current.onSaveAgentDefaultChange('global'))
    await act(async () =>
      reply.resolve({
        settings: projectAgentLaunchSettings({
          defaultTuiAgent: 'codex',
          disabledTuiAgents: ['opencode', 'claude']
        })
      })
    )
    expect(view.result.current.surfaceRows.model).toMatchObject({
      state: 'settled',
      rows: [{ agent: 'codex', kind: 'cli' }]
    })
    expect(view.result.current.selectedAgent).toBe('codex')
    expect(view.result.current.canStart).toBe(true)
    expect(view.result.current.saveTargetValue).toBe('global')
    expect(view.result.current.agentScopeNote).toBeNull()
    await act(() => view.result.current.handleStart())
    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        agentArgs: '--dangerously-bypass-approvals-and-sandbox --model chosen',
        sessionOptions: { model: 'chosen' },
        agentLaunchPreferences: {
          agentLaunchChoices: {},
          defaultTuiAgent: 'codex',
          disabledTuiAgents: ['opencode', 'claude']
        }
      })
    )
    expect(onSaveAgentDefault).toHaveBeenCalledWith(
      { type: 'global' },
      'resolveConflicts',
      expect.objectContaining({ agentId, agentArgs: '--model chosen' })
    )
    expect(useAppStore.getState().settings).toBe(settings)
  }
)

it.each([
  { saved: 'claude' as const, model: 'opus', terminal: true },
  { saved: null, model: undefined, terminal: false }
])(
  'keeps captured choices through actual same-agent picker dispatch, complete Save, Start and reopen (%s)',
  async ({ saved, model, terminal }) => {
    const global: SourceControlActionRecipe = {
      agentId: 'claude',
      agentArgs: '--verbose',
      launchPreferences: {
        agentId: 'claude',
        ...(model ? { model } : {}),
        options: { effort: 'high' }
      }
    }
    const own: SourceControlActionRecipe = {
      agentId: saved,
      launchPreferences: { agentId: 'claude', permissionMode: 'ask' }
    }
    const f = mountSourceDialog(global, own)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save & start agent' }).hasAttribute('disabled')
      ).toBe(false)
    )
    await pickDialogAgent('Claude', terminal)
    if (terminal) {
      expect(
        screen.getByRole<HTMLInputElement>('textbox', { name: 'Extra CLI arguments' }).value
      ).toBe('--verbose')
    } else {
      expect(screen.queryByRole('textbox', { name: 'Extra CLI arguments' })).toBeNull()
    }
    expect(screen.getByText(/High/).textContent).toContain('High')
    if (model) {
      expect(screen.getByText(/High/).textContent).toContain('Opus')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save & start agent' }))
    await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
    const options = { ...(model ? { model } : {}), effort: 'high', permissionMode: 'ask' }
    expect(f.onStart).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'claude', agentArgs: '--verbose', sessionOptions: options })
    )
    expect(f.persist).toHaveBeenCalledOnce()
    const savedRecipe = f.persist.mock.calls[0][2]
    expect(savedRecipe.launchPreferences).toEqual({
      agentId: 'claude',
      permissionMode: 'ask',
      modelSelection: {
        base: 'default',
        ...(model ? { model: { agentId: 'claude', value: model } } : {}),
        options: { effort: { agentId: 'claude', value: 'high' } }
      }
    })
    expect(
      projectSourceControlActionLaunch(freshDialogRecipe(f.repo.id), 'claude', {
        basePrompt: 'fix'
      })
    ).toMatchObject({ agentArgs: '--verbose', sessionOptions: options })
    f.view.unmount()
    const reopened = f.mount()
    expect(screen.getByText(/High/).textContent).toContain('High')
    reopened.unmount()
  }
)

it('distinguishes masked eligibility from owning reset and uses the captured parent through Save/Start', async () => {
  const global: SourceControlActionRecipe = {
    agentId: 'codex',
    agentArgs: '',
    launchPreferences: {
      agentId: 'codex',
      permissionMode: 'own',
      modelSelection: {
        base: 'default',
        model: { agentId: 'codex', value: 'o3' }
      }
    }
  }
  const own: SourceControlActionRecipe = {
    agentId: 'claude',
    launchPreferences: {
      agentId: 'claude',
      permissionMode: 'ask',
      modelSelection: {
        base: 'inherit',
        model: { agentId: 'claude', value: 'opus' }
      }
    }
  }
  const f = mountSourceDialog(global, own)
  const captured = resolveSourceControlActionRecipe({
    settings: useAppStore.getState().settings,
    repo: f.repo,
    actionId: 'resolveConflicts'
  })
  expect(
    projectSourceControlActionLaunch(captured, 'codex', {
      basePrompt: 'fix'
    }).sessionOptions
  ).toBeUndefined()
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save & start agent' }).hasAttribute('disabled')
    ).toBe(false)
  )
  act(() =>
    useAppStore.setState((state) => ({
      settings: {
        ...state.settings!,
        sourceControlAi: {
          ...state.settings!.sourceControlAi!,
          actions: {
            resolveConflicts: { ...global, launchPreferences: { agentId: 'codex', model: 'later' } }
          }
        }
      }
    }))
  )
  await pickDialogAgent('Codex', true)
  expect(screen.getByText(/Model from Settings: o3/)).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: 'Save & start agent' }))
  await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
  expect(f.onStart).toHaveBeenCalledWith(
    expect.objectContaining({ agent: 'codex', agentArgs: '', sessionOptions: { model: 'o3' } })
  )
  expect(f.persist.mock.calls[0][2]).toMatchObject({
    agentId: 'codex',
    agentArgs: '',
    launchPreferences: {
      agentId: 'codex',
      modelSelection: {
        base: 'default',
        model: { agentId: 'codex', value: 'o3' }
      }
    }
  })
  expect(f.persist.mock.calls[0][2].launchPreferences).toEqual({
    agentId: 'codex',
    modelSelection: { base: 'default', model: { agentId: 'codex', value: 'o3' } }
  })
  expect(f.persist.mock.calls[0][2]).not.toHaveProperty('resolvedChoiceSources')
  expect(
    projectSourceControlActionLaunch(freshDialogRecipe(f.repo.id), 'codex', { basePrompt: 'fix' })
      .sessionOptions
  ).toEqual({ model: 'o3' })
  await pickDialogAgent('Claude', false)
  await pickDialogAgent('Codex', true)
  expect(screen.queryByText(/Opus/)).toBeNull()
  f.view.unmount()
  const reopened = f.mount()
  expect(screen.getByText(/Model from Settings: o3/)).toBeDefined()
  reopened.unmount()
  useAppStore.setState((state) => ({
    repos: state.repos.map((row) =>
      row.id === f.repo.id
        ? {
            ...row,
            sourceControlAi: { actionOverrides: { resolveConflicts: { agentId: 'codex' } } }
          }
        : row
    )
  }))
  const fresh = f.mount()
  expect(screen.getByText(/Model from Settings: later/)).toBeDefined()
  fresh.unmount()
})

it('retains newly eligible literal syntax, demotes obsolete syntax once and does not restore it after switching back', async () => {
  const global = liftActionPermissionArgs<SourceControlActionRecipe>({
    agentId: 'claude' as const,
    agentArgs: '--model opus --effort high --verbose'
  })
  const f = mountSourceDialog(global, {
    agentId: 'codex',
    launchPreferences: { agentId: 'codex', permissionMode: 'ask' }
  })
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save & start agent' }).hasAttribute('disabled')
    ).toBe(false)
  )
  await pickDialogAgent('Claude', true)
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Extra CLI arguments' }).value).toBe(
    '--verbose'
  )
  expect(screen.getByText(/Opus/).textContent).toContain('High')
  fireEvent.click(screen.getByRole('button', { name: 'Save & start agent' }))
  await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
  expect(f.onStart).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'claude',
      agentArgs: '--verbose',
      sessionOptions: { model: 'opus', effort: 'high' }
    })
  )
  const saved = f.persist.mock.calls[0][2]
  expect(saved.argumentChoices).toEqual(global.argumentChoices)
  expect(saved.launchPreferences).toBeUndefined()
  await pickDialogAgent('Codex', true)
  const text = screen.getByRole<HTMLInputElement>('textbox', { name: 'Extra CLI arguments' })
  expect(text.value).toBe('--model opus  --effort high --verbose')
  await pickDialogAgent('Claude', true)
  expect(screen.queryByText(/Model from Settings/)).toBeNull()
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Extra CLI arguments' }).value).toBe(
    '--model opus  --effort high --verbose'
  )
})

it('keeps an owned empty-Args default barrier and submitted choices across failed Save, newer edits and Discard', async () => {
  const done = Promise.withResolvers<void>()
  const save = vi.fn<SaveAction>(() => done.promise)
  const f = mountSourceDialog(
    { agentId: 'codex', launchPreferences: { agentId: 'codex', model: 'o3' } },
    {
      agentId: 'claude',
      agentArgs: '',
      launchPreferences: {
        agentId: 'claude',
        modelSelection: { base: 'inherit', model: { agentId: 'claude', value: null } }
      }
    },
    save
  )
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Save & start agent' }).hasAttribute('disabled')
    ).toBe(false)
  )
  await pickDialogAgent('Codex', true)
  expect(screen.queryByText(/Model from Settings/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save & start agent' }))
  await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
  expect(f.onStart.mock.calls[0][0]).toMatchObject({
    agent: 'codex',
    agentArgs: '',
    commandInput: 'fix'
  })
  expect(f.onStart.mock.calls[0][0].sessionOptions).toBeUndefined()
  fireEvent.change(screen.getByRole('textbox', { name: 'Extra CLI arguments' }), {
    target: { value: '--newer' }
  })
  await act(async () => done.reject(new Error('write failed')))
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Extra CLI arguments' }).value).toBe(
    '--newer'
  )
  expect(save.mock.calls[0][2].agentArgs).toBe('')
  expect(f.onStart).toHaveBeenCalledOnce()
  expect(useAppStore.getState().repos[0].sourceControlAi).toEqual(f.repo.sourceControlAi)
  expect(freshDialogRecipe(f.repo.id).agentId).toBe('claude')
  f.view.unmount()
  const fresh = f.mount()
  await pickDialogAgent('Claude', true)
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Extra CLI arguments' }).value).toBe(
    ''
  )
  fresh.unmount()
})

it.each([
  { agent: 'claude', pair: false, save: false, native: false, scope: 'global' },
  { agent: 'claude', pair: true, save: true, native: false, scope: 'repo' },
  { agent: 'claude', pair: false, save: true, native: false, scope: 'global' },
  { agent: 'claude', pair: true, save: true, native: true, scope: 'repo' },
  { agent: 'codex', pair: true, save: false, native: true, scope: 'repo' },
  { agent: 'codex', pair: true, save: false, native: true, scope: 'repo', foreignDocument: true },
  { agent: 'claude', pair: true, save: false, native: true, scope: 'repo', defaultGroup: true },
  { agent: 'claude', pair: false, save: false, native: true, scope: 'repo', defaultGroup: true },
  { agent: 'claude', pair: false, save: true, native: false, scope: 'repo', typedDefault: true },
  { agent: 'claude', pair: false, save: true, native: true, scope: 'repo', typedDefault: true }
] as const)(
  'commits edited $agent literals once through Start/save=$save/native=$native/$scope and fresh reopen',
  async (row) => {
    const { agent, pair, save, native, scope } = row
    const original =
      agent === 'claude'
        ? `--model opus ${pair || save || 'defaultGroup' in row ? '--effort high ' : ''}--verbose`
        : '-m gpt-5.4 -c model_reasoning_effort=high --verbose'
    const replacement =
      agent === 'claude'
        ? `--model sonnet ${pair ? '--effort low ' : ''}--verbose`
        : '-m gpt-5.5 -c model_reasoning_effort=low --verbose'
    const global = liftActionPermissionArgs<SourceControlActionRecipe>({
      agentId: 'foreignDocument' in row ? 'claude' : agent,
      surface: 'terminal',
      agentArgs: 'foreignDocument' in row ? '--model opus --effort high --verbose' : original
    })
    const f = mountSourceDialog(
      'typedDefault' in row
        ? {
            ...global,
            argumentChoices: undefined,
            launchPreferences: {
              agentId: agent,
              modelSelection: {
                base: 'default',
                model: { agentId: agent, value: 'opus' },
                options: { effort: { agentId: agent, value: 'high' } }
              }
            }
          }
        : global,
      {
        agentId: agent,
        surface: 'terminal',
        ...('defaultGroup' in row || 'typedDefault' in row
          ? {
              launchPreferences: { agentId: agent, modelSelection: { base: 'default' as const } }
            }
          : {})
      },
      undefined,
      undefined,
      scope
    )
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', {
            name: /^(Save & start agent|Start agent)$/
          })
          .hasAttribute('disabled')
      ).toBe(false)
    )
    if ('typedDefault' in row) {
      const state = useAppStore.getState()
      const captured = captureSourceControlActionSelection({
        settings: state.settings,
        repo: state.repos[0],
        actionId: 'resolveConflicts'
      })
      const committed = commitSourceControlActionArguments(
        editSourceControlActionArguments(captured, replacement),
        agent
      )
      expect(committed.selection.source).toEqual(captured.source)
      expect(committed.selection.source).toMatchObject({
        scope: 'repo',
        ownsArgs: false,
        authoredPreferences: { agentId: agent, modelSelection: { base: 'default' } },
        parentPreferences: {
          modelSelection: { model: { value: 'opus' }, options: { effort: { value: 'high' } } }
        }
      })
      expect(committed.recipe.resolvedChoiceSources).toMatchObject({
        model: { base: 'default' },
        literalKeys: ['model'],
        permission: captured.source.authoredPreferences
      })
    }
    fireEvent.change(screen.getByRole('textbox', { name: 'Extra CLI arguments' }), {
      target: { value: replacement }
    })
    if (native) {
      await pickDialogAgent(agent === 'claude' ? 'Claude' : 'Codex', false)
      expect(screen.queryByRole('textbox', { name: 'Extra CLI arguments' })).toBeNull()
    }
    if (save && scope === 'repo') {
      await pickDialogSaveTarget('This repository')
    }
    if (!save) {
      fireEvent.click(screen.getByRole('checkbox'))
    }
    // No blur: submission itself must settle the pending edit.
    fireEvent.click(
      screen.getByRole('button', { name: save ? 'Save & start agent' : 'Start agent' })
    )
    await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
    const options = {
      model: agent === 'claude' ? 'sonnet' : 'gpt-5.5',
      ...(pair ? { effort: 'low' } : {})
    }
    const submitted = f.onStart.mock.calls[0][0]
    const residual =
      'foreignDocument' in row
        ? '--model opus  --effort high --verbose'
        : 'defaultGroup' in row && !pair
          ? '--effort high --verbose'
          : '--verbose'
    expect(submitted).toMatchObject({ agent, agentArgs: residual, sessionOptions: options })
    expect(submitted.sessionOptions).toEqual(options)
    const plan = submittedActionStartupPlan(submitted)
    expect(plan?.launchCommand).toBe(
      agent === 'claude'
        ? `claude ${'defaultGroup' in row && !pair ? "'--effort' 'high' " : ''}'--verbose' '--model' 'sonnet'${pair ? " '--effort' 'low'" : ''} 'fix'`
        : `codex '-c' 'disable_paste_burst=true' ${'foreignDocument' in row ? "'--effort' 'high' " : ''}'--verbose' '-m' 'gpt-5.5' '-c' 'model_reasoning_effort=low' 'fix'`
    )
    if (native) {
      expect(submitted.launchChoice?.requestedSurface).toBe('chat')
      expect(
        structuredLaunchRequestedOptions({
          explicit: submitted.sessionOptions,
          seed: { model: 'remembered', effort: 'high' },
          held: {}
        })
      ).toEqual(options)
      expect(
        structuredLaunchRequestedOptions({
          explicit: submitted.sessionOptions,
          seed: { effort: 'high' },
          held: { effort: 'medium' }
        })
      ).toEqual({ ...options, effort: 'medium' })
    }
    expect(f.persist).toHaveBeenCalledTimes(save ? 1 : 0)
    if (save) {
      const saved = f.persist.mock.calls[0][2]
      expect(saved.agentArgs).toBe('--verbose')
      expect(saved.argumentChoices?.nodes.map((node) => node.text)).toEqual([
        '--model sonnet',
        ...(pair ? ['--effort low'] : [])
      ])
      expect(saved).not.toHaveProperty('resolvedChoiceSources')
      const state = useAppStore.getState()
      const fresh = resolveSourceControlActionRecipe({
        settings: state.settings,
        repo: scope === 'repo' ? state.repos[0] : undefined,
        actionId: 'resolveConflicts'
      })
      expect(projectSourceControlActionLaunch(fresh, agent, { basePrompt: 'fix' })).toMatchObject({
        agentArgs: '--verbose',
        sessionOptions: options
      })
      f.view.unmount()
      const reopened = f.mount()
      if (native) {
        await waitFor(() =>
          expect(screen.queryByRole('textbox', { name: 'Extra CLI arguments' })).toBeNull()
        )
      } else {
        expect(
          screen.getByRole<HTMLInputElement>('textbox', { name: 'Extra CLI arguments' }).value
        ).toBe('--verbose')
      }
      reopened.unmount()
    }
  }
)

it.each([
  { edit: undefined, raw: '--model sonnet --verbose' },
  { edit: '--unrelated', raw: '--unrelated' },
  { edit: '', raw: '' }
])('preserves untouched conflict or untouched nodes for residual $edit', async ({ edit, raw }) => {
  const global = liftActionPermissionArgs<SourceControlActionRecipe>({
    agentId: 'claude',
    surface: 'terminal',
    agentArgs: '--model opus --effort high --verbose'
  })
  const f = mountSourceDialog(
    { ...global, agentArgs: edit === undefined ? raw : global.agentArgs },
    {}
  )
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeDefined())
  if (edit !== undefined) {
    fireEvent.change(screen.getByRole('textbox', { name: 'Extra CLI arguments' }), {
      target: { value: edit }
    })
  }
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
  await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
  expect(f.onStart.mock.calls[0][0]).toMatchObject({
    agentArgs: raw,
    sessionOptions: { model: 'opus', effort: 'high' }
  })
  expect(f.persist).not.toHaveBeenCalled()
})

it('replaces the selected captured parent key without flattening sparse ownership or permission', async () => {
  const f = mountSourceDialog(
    {
      agentId: 'claude',
      surface: 'terminal',
      agentArgs: '--verbose',
      launchPreferences: { agentId: 'claude', model: 'opus', options: { effort: 'high' } }
    },
    {
      launchPreferences: {
        agentId: 'claude',
        permissionMode: 'ask',
        modelSelection: {
          base: 'inherit',
          options: { fastMode: { agentId: 'codex', value: 'true' } }
        }
      }
    }
  )
  await waitFor(() => expect(screen.getByRole('checkbox')).toBeDefined())
  act(() =>
    useAppStore.setState((state) => ({
      settings: {
        ...state.settings!,
        sourceControlAi: {
          ...state.settings!.sourceControlAi!,
          actions: {
            resolveConflicts: {
              agentId: 'claude',
              launchPreferences: { agentId: 'claude', model: 'later' }
            }
          }
        }
      }
    }))
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Extra CLI arguments' }), {
    target: { value: '--model sonnet --verbose' }
  })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
  await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
  expect(f.onStart.mock.calls[0][0]).toMatchObject({
    agentArgs: '--verbose',
    sessionOptions: { model: 'sonnet', permissionMode: 'ask' }
  })
  expect(f.persist).not.toHaveBeenCalled()
})

it('settles pending replacement in its old grammar before a genuine agent demotion', async () => {
  const f = mountSourceDialog(
    liftActionPermissionArgs<SourceControlActionRecipe>({
      agentId: 'claude',
      surface: 'terminal',
      agentArgs: '--model opus --effort high --verbose'
    }),
    {}
  )
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Extra CLI arguments' })).toBeDefined()
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'Extra CLI arguments' }), {
    target: { value: '--model sonnet --verbose' }
  })
  await pickDialogAgent('Codex', true)
  expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Extra CLI arguments' }).value).toBe(
    '--model sonnet --verbose'
  )
  await pickDialogAgent('Claude', true)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
  await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
  expect(f.onStart.mock.calls[0][0].sessionOptions).toBeUndefined()
  expect(f.onStart.mock.calls[0][0].agentArgs).toBe('--model sonnet --verbose')
})

it.each([
  { raw: 'acceptEdits', permission: 'accept-edits', residual: '--verbose' },
  { raw: 'plan', permission: 'ask', residual: '--permission-mode plan --verbose' }
] as const)(
  'keeps independent effort and separately selected permission for raw $raw',
  async ({ raw, permission, residual }) => {
    const f = mountSourceDialog(
      {
        agentId: 'claude',
        surface: 'terminal',
        agentArgs: '--verbose',
        launchPreferences: { agentId: 'claude', options: { effort: 'high' }, permissionMode: 'ask' }
      },
      {}
    )
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Extra CLI arguments' })).toBeDefined()
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Extra CLI arguments' }), {
      target: { value: `--model sonnet --permission-mode ${raw} --verbose` }
    })
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Start agent' }))
    await waitFor(() => expect(f.onStart).toHaveBeenCalledOnce())
    expect(f.onStart.mock.calls[0][0]).toMatchObject({
      agentArgs: residual,
      sessionOptions: { model: 'sonnet', effort: 'high', permissionMode: permission }
    })
    expect(f.persist).not.toHaveBeenCalled()
  }
)
