import { registerRepositoryStagedSetupTest } from './repository-staged-setup.test-fixture'
import { registerRepoSourceExtentTests } from './repository-source-extent.test-fixture'
import {
  saveSourceControlActionRecipe,
  toSourceControlAiRepoUpdate
} from '../../../../../../shared/source-control/ai/settings/source-control-ai-recipe-save'
// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, cleanup, fireEvent, screen, within, waitFor } from '@testing-library/react'
import React from 'react'
import * as agentRoute from '@/lib/agent-launch-route-input'
import * as agentInventory from '@/lib/agent-detection-target-inventory'
import type { Repo } from '../../../../../../shared/repo-types'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { createRepoActionTextDraftEditors } from './repository-source-control-ai-text-draft'
import type { RepoSourceControlAiOverrides } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import {
  setSourceControlActionAgentDefault,
  SOURCE_CONTROL_LAUNCH_ACTION_IDS
} from '../../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import {
  computeActionDirtyById,
  withRepoAiActionMode,
  withRepoAiActionRecipeText
} from './repository-source-control-ai-draft'
import { withRepoAiActionAgent } from './repository-source-control-ai-action-agent-draft'
import { resolveSourceControlActionRecipe } from '../../../../../../shared/source-control/ai/source-control-ai-operation-policy'

import { sourceControlActionRecipeMatchesTarget } from '../../../right-sidebar/source-control-action-recipe-match'
import { SourceControlActionAgentPicker } from '../../source-control/SourceControlActionAgentPicker'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'
import { SourceControlAiActionRecipeDefaults } from '../../source-control/SourceControlAiActionRecipeDefaults'
import { useAppStore } from '../../../../store/index'
import { TooltipProvider } from '../../../ui/tooltip'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { projectSourceControlActionLaunch } from '../../../../../../shared/source-control/ai/recipes/source-control-action-launch-preferences'
import { projectAgentLaunchSettings } from '../../../../../../shared/agent-launch/choices/agent-launch-settings'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { clearHostAgentMenuSettingsForTests } from '../../../../runtime/agent-launch-settings/host-agent-launch-preferences-resource'
import { mutateHostAgentLaunchSettings } from '../../../../runtime/agent-launch-settings/agent-launch-settings-transport'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
import { resolveAgentStartupPlanInputs } from '../../../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../../../../../../shared/agent-launch/startup/tui-agent-startup'
import { tokenizeStartupCommand } from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
afterEach(() => {
  cleanup()
  clearHostAgentMenuSettingsForTests()
  resetHostStructuredAgentsForTests()
  setLocalRuntimeCapabilitiesForTests(null)
})
describe('saved chat-or-CLI pick', () => {
  it('stays bound to its agent through reads, inheritance, Customize, agent changes and saves', () => {
    const base = useAppStore.getState().settings!
    const actions = { fixChecks: { agentId: 'codex' as const, surface: 'terminal' as const } }
    const settings = { ...base, sourceControlAi: { ...base.sourceControlAi!, actions } }
    const resolve = (sourceControlAi: RepoSourceControlAiOverrides) =>
      resolveSourceControlActionRecipe({
        settings,
        repo: { sourceControlAi },
        actionId: 'fixChecks'
      }).surface
    expect(resolve({})).toBe('terminal')
    // A repo on its own agent never inherits the global agent's pick.
    expect(resolve({ actionOverrides: { fixChecks: { agentId: 'claude' } } })).toBeUndefined()

    const customized = withRepoAiActionMode({}, settings, 'fixChecks', 'override')
    expect(customized.actionOverrides?.fixChecks?.surface).toBe('terminal')
    const repoSurface = (agent: 'codex' | 'claude') =>
      withRepoAiActionAgent(customized, settings, 'fixChecks', agent).actionOverrides?.fixChecks
        ?.surface
    expect([repoSurface('codex'), repoSurface('claude')]).toEqual(['terminal', undefined])
    // Changing the agent (or choosing "Use default agent") drops it even with no saved model.
    const globalSurface = (agent: 'codex' | 'claude' | null) =>
      setSourceControlActionAgentDefault(actions, 'fixChecks', agent).fixChecks?.surface
    expect([globalSurface('codex'), globalSurface('claude'), globalSurface(null)]).toEqual([
      'terminal',
      undefined,
      undefined
    ])

    const recipe = { agentId: 'codex' as const, commandInputTemplate: '{basePrompt}' }
    const saved = saveSourceControlActionRecipe({
      target: { type: 'repo', repoId: 'repo-1' },
      settings,
      repo: { sourceControlAi: {} },
      actionId: 'fixChecks',
      recipe: { ...recipe, surface: 'terminal' }
    })
    const savedRepoAi = 'update' in saved ? saved.update.sourceControlAi : null
    expect(savedRepoAi?.actionOverrides?.fixChecks?.surface).toBe('terminal')
    const matches = (surface: 'chat' | 'terminal') =>
      sourceControlActionRecipeMatchesTarget({
        actionId: 'fixChecks',
        target: { type: 'repo', repoId: 'repo-1' },
        recipe: { ...recipe, surface },
        settings,
        repo: { sourceControlAi: savedRepoAi ?? undefined }
      })
    expect([matches('terminal'), matches('chat')]).toEqual([true, false])
  })
})

describe('RepositorySourceControlAiActionRows', () => {
  it.each([
    { agent: 'codex', detected: ['codex'], surface: undefined },
    { agent: 'codex', detected: ['codex'], surface: 'terminal' },
    { agent: 'codex', detected: ['codex'], surface: 'chat' },
    { agent: 'opencode', detected: ['opencode'], surface: undefined },
    { agent: 'codex', detected: ['claude'], surface: undefined }
  ] as const)(
    'keeps saved $agent/$surface controls bound across detection returning $detected',
    async ({ agent, detected, surface }) => {
      useAppStore.getState().clearLocalDetectedAgents()
      const settings = useAppStore.getState().settings!
      const recipe = {
        agentId: agent,
        surface,
        launchPreferences: {
          agentId: agent,
          permissionMode: 'ask' as const,
          model: 'saved',
          options: { fastMode: 'false' }
        },
        agentArgs: '--saved-cli',
        commandInputTemplate: 'kept-template'
      }
      const source = {
        ...settings.sourceControlAi!,
        enabled: true,
        actions: { fixCommitFailure: recipe }
      }
      const originalRecipe = JSON.stringify(recipe)
      let finish: (ids: string[]) => void = () => {}
      const detectAgents = vi.fn(
        () =>
          new Promise<string[]>((resolve) => {
            finish = resolve
          })
      )
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { preflight: { detectAgents } }
      })
      useAppStore.setState({
        repos: [{ ...TEST_REPO, id: 'repo-1' }],
        settings: {
          ...settings,
          nativeChatProviders: {},
          defaultTuiAgent: 'claude',
          sourceControlAi: source
        },
        settingsSearchQuery: '',
        localDetectedAgentIdsByContext: {}
      })
      const ensure = vi.spyOn(useAppStore.getState(), 'ensureNativeDetectedAgents')
      const writeConfig = vi.fn()
      const onEdit = vi.fn()
      const view = render(
        React.createElement(
          TooltipProvider,
          null,
          React.createElement(SourceControlAiActionRecipeDefaults, {
            config: source,
            defaultTuiAgent: 'claude',
            searchQuery: '',
            writeConfig
          }),
          React.createElement(RepositorySourceControlAiActionRows, {
            repoId: 'repo-1',
            repo: useAppStore.getState().repos[0],
            repoAi: { actionOverrides: { fixCommitFailure: recipe } },
            source,
            defaultTuiAgent: 'claude',
            savingActionIds: {},
            actionDirtyById: computeActionDirtyById({}, {}, {}),
            onActionModeChange: onEdit,
            onActionAgentChange: onEdit,
            onActionLaunchPreferencesChange: onEdit,
            onActionTemplateChange: onEdit,
            onActionAgentArgsChange: onEdit,
            onAppendVariable: onEdit,
            onActionDiscard: onEdit,
            onActionSave: onEdit
          })
        )
      )
      await act(async () => {})
      const cards = Array.from(view.container.querySelectorAll('textarea'))
        .filter((field) => field.value === 'kept-template')
        .map((field) => field.parentElement!.closest('.rounded-md')!)
      expect(cards).toHaveLength(2)
      expect(ensure).toHaveBeenCalledTimes(2)
      expect(detectAgents).toHaveBeenCalledTimes(1)
      const triggers = () =>
        cards.map((card) =>
          card.querySelector<HTMLButtonElement>('button[aria-label="Select agent"]')!
        )
      expect(triggers().every((trigger) => trigger.disabled)).toBe(true)
      await act(async () => finish([...detected]))
      expect(triggers().every((trigger) => !trigger.disabled)).toBe(true)
      for (const chat of [true, false]) {
        await act(() =>
          useAppStore.setState({
            settings: {
              ...useAppStore.getState().settings!,
              nativeChatProviders: chat ? EVERY_AGENT_CHAT : {}
            }
          })
        )
        for (const card of cards) {
          expect(
            card.querySelector('button[aria-label="Select agent"]')?.textContent?.toLowerCase()
          ).toContain(agent)
          expect(card.querySelector('textarea[aria-label="Arguments"]')).toBeNull()
          expect(card.querySelector('textarea')?.value).toBe('kept-template')
        }
      }
      expect(JSON.stringify(source.actions.fixCommitFailure)).toBe(originalRecipe)
      expect(writeConfig).not.toHaveBeenCalled()
      expect(onEdit).not.toHaveBeenCalled()
    }
  )
})

it.each(['', '--model raw'])(
  'a repository agent/surface edit keeps its owned Arguments group without pinning global choices (%s)',
  (agentArgs) => {
    const settings = useAppStore.getState().settings!
    const launchPreferences = {
      agentId: 'codex' as const,
      model: 'saved',
      permissionMode: 'ask' as const
    }
    const sourceSettings = {
      ...settings,
      sourceControlAi: {
        ...settings.sourceControlAi!,
        actions: { fixChecks: { agentId: 'codex' as const, agentArgs: '', launchPreferences } }
      }
    }
    const edited = withRepoAiActionAgent(
      { actionOverrides: { fixChecks: { commandInputTemplate: '{basePrompt}', agentArgs } } },
      sourceSettings,
      'fixChecks',
      'codex',
      { surface: 'terminal' }
    )
    expect(edited.actionOverrides?.fixChecks).toMatchObject({
      agentId: 'codex',
      agentArgs,
      surface: 'terminal'
    })
    expect(edited.actionOverrides?.fixChecks?.launchPreferences).toBeUndefined()
    const payload = toSourceControlAiRepoUpdate(edited).sourceControlAi
    const replay = resolveSourceControlActionRecipe({
      settings: sourceSettings,
      repo: { sourceControlAi: payload ?? undefined },
      actionId: 'fixChecks'
    })
    expect(replay).toMatchObject({ agentArgs, surface: 'terminal' })
    expect(replay.launchPreferences).toBeUndefined()
    expect(replay.launchPreferencesYieldToAgentArgs).toBeUndefined()
    const changedAgent = withRepoAiActionAgent(edited, sourceSettings, 'fixChecks', 'claude', {
      surface: 'chat'
    })
    expect(changedAgent.actionOverrides?.fixChecks?.launchPreferences).toBeUndefined()
  }
)

it.each(['own', 'parent'] as const)(
  'removes the %s action model through the repository writer and delegates startup without owning Arguments',
  async (owner) => {
    rpc.mockReset().mockResolvedValue(undefined)
    setLocalRuntimeCapabilitiesForTests([])
    const base = useAppStore.getState().settings!
    const model = { agentId: 'claude' as const, model: 'sonnet' }
    const source = {
      ...base.sourceControlAi!,
      actions: {
        resolveConflicts: {
          agentId: 'claude' as const,
          ...(owner === 'parent' ? { launchPreferences: model } : {})
        }
      }
    }
    const own: RepoSourceControlAiOverrides = {
      actionOverrides: {
        resolveConflicts: {
          commandInputTemplate: '{basePrompt}',
          ...(owner === 'own' ? { launchPreferences: model } : {})
        }
      }
    }
    const settings = {
      ...base,
      nativeChatProviders: {},
      agentPermissionDefault: 'own' as const,
      agentDefaultArgs: { claude: '--model opus --verbose' },
      sourceControlAi: source
    }
    useAppStore.setState({
      settings,
      repos: [TEST_REPO],
      localDetectedAgentIdsByContext: { host: ['claude'] }
    })
    const change = vi.fn()
    const tree = (repoAi: RepoSourceControlAiOverrides) =>
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(RepositorySourceControlAiActionRows, {
          repoId: TEST_REPO.id,
          repo: TEST_REPO,
          repoAi,
          source,
          defaultTuiAgent: 'claude',
          savingActionIds: {},
          actionDirtyById: computeActionDirtyById({}, {}, {}),
          onActionModeChange: vi.fn(),
          onActionAgentChange: vi.fn(),
          onActionLaunchPreferencesChange: change,
          onActionTemplateChange: vi.fn(),
          onActionAgentArgsChange: vi.fn(),
          onAppendVariable: vi.fn(),
          onActionDiscard: vi.fn(),
          onActionSave: vi.fn()
        })
      )
    const view = render(tree(own))
    const configure = async () => {
      const row = within(screen.getByText('Conflict resolution').closest<HTMLElement>('[id]')!)
      const trigger = row.getByRole('button', { name: 'Select agent' })
      await waitFor(() => expect(trigger).toHaveProperty('disabled', false))
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
      fireEvent.click(screen.getByRole('button', { name: 'Configure Claude' }))
    }
    await configure()
    fireEvent.click(screen.getByRole('button', { name: 'Remove --model sonnet' }))
    fireEvent.click(screen.getByRole('button', { name: 'Launch terminal' }))
    expect(change).toHaveBeenCalledOnce()
    const [actionId, preferences, args, nodes] = change.mock.calls[0]
    expect(args).toBeUndefined()
    expect(preferences.modelSelection.model).toEqual({ agentId: 'claude', value: null })
    let drafts: Parameters<typeof withRepoAiActionRecipeText>[3] | undefined
    const writers = createRepoActionTextDraftEditors(
      (update) => {
        const next = typeof update === 'function' ? update({}) : update
        drafts = next.resolveConflicts
      },
      { current: own },
      source
    )
    writers.updateActionLaunchPreferences(actionId, preferences, args, nodes)
    if (!drafts) {
      throw new Error('Expected authored recipe draft')
    }
    const saved = withRepoAiActionRecipeText(own, settings, actionId, drafts)
    expect(saved.actionOverrides?.resolveConflicts?.agentArgs).toBeUndefined()
    expect(source.actions.resolveConflicts).toEqual({
      agentId: 'claude',
      ...(owner === 'parent' ? { launchPreferences: model } : {})
    })
    const reopened = resolveSourceControlActionRecipe({
      settings,
      repo: { sourceControlAi: saved },
      actionId
    })
    const launch = projectSourceControlActionLaunch(reopened, 'claude', { basePrompt: 'fix' })
    expect(launch.sessionOptions?.model).toBeUndefined()
    expect(launch.agentArgs).toBeUndefined()
    const startup = buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings,
        platform: 'darwin',
        isRemote: false,
        shell: 'posix',
        agentArgs: launch.agentArgs,
        sessionOptions: launch.sessionOptions
      }),
      prompt: 'fix'
    })
    if (!startup) {
      throw new Error('Expected terminal startup')
    }
    const command = tokenizeStartupCommand(startup.launchCommand, 'posix')
    expect(command.ok).toBe(true)
    if (!command.ok) {
      throw new Error(command.error)
    }
    expect(command.tokens).toEqual(['claude', '--model', 'opus', '--verbose', 'fix'])
    fireEvent.keyDown(document, { key: 'Escape' })
    view.rerender(tree(saved))
    await configure()
    expect(screen.queryByRole('button', { name: 'Remove --model sonnet' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove --model opus' })).toBeNull()
    expect(document.querySelector('[cmdk-item][data-current="true"]')).toBeNull()
  }
)

it('keeps default and missing-agent editors disabled only until the host inventory settles', async () => {
  const settings = useAppStore.getState().settings!
  useAppStore.setState({
    settings: { ...settings, nativeChatProviders: {} },
    detectedAgentIds: null,
    ensureDetectedAgents: vi.fn(() => new Promise<TuiAgent[]>(() => {}))
  })
  const onPick = vi.fn()
  const picker = (agent: 'codex' | null) =>
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(SourceControlActionAgentPicker, { agent, onPick })
    )
  const view = render(picker(null))
  expect(view.getByRole('button', { name: 'Select agent' }).hasAttribute('disabled')).toBe(true)
  view.rerender(picker('codex'))
  expect(view.getByRole('button', { name: 'Select agent' }).hasAttribute('disabled')).toBe(true)
  await act(async () => useAppStore.setState({ detectedAgentIds: ['claude'] }))
  expect(view.getByRole('button', { name: 'Select agent' }).hasAttribute('disabled')).toBe(false)
  expect(onPick).not.toHaveBeenCalled()
  fireEvent.pointerDown(view.getByRole('button', { name: 'Select agent' }), {
    button: 0,
    ctrlKey: false
  })
  const available = view.getAllByRole('menuitem').find((row) => row.textContent?.includes('Claude'))
  expect(available).toBeDefined()
  fireEvent.click(available!)
  expect(onPick).toHaveBeenCalledWith('claude', {})
})

it.each([1, 10])(
  'shares one host request lifetime across %i real Settings sections and all five launch rows',
  async (sections) => {
    const settings = useAppStore.getState().settings!
    const recipe = {
      agentId: null,
      launchPreferences: { agentId: 'codex' as const, model: 'saved-model' }
    }
    const actions = Object.fromEntries(
      [
        'fixCommitFailure',
        'fixPushFailure',
        'fixChecks',
        'resolveConflicts',
        'resolveComments'
      ].map((id) => [id, recipe])
    )
    const pending = Promise.withResolvers<{
      settings: ReturnType<typeof projectAgentLaunchSettings>
    }>()
    rpc.mockImplementation((_target, method) =>
      method === 'settings.getAgentLaunch' ? pending.promise : Promise.resolve({ settings: host })
    )
    const gets = () => rpc.mock.calls.filter((call) => call[1] === 'settings.getAgentLaunch')
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const cleared = vi.spyOn(globalThis, 'clearTimeout')
    const deadlines = () =>
      timers.mock.calls.flatMap((call, i) =>
        call[1] === 3_000 ? [timers.mock.results[i].value] : []
      )
    const host = projectAgentLaunchSettings({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['claude']
    })
    useAppStore.setState({
      settings: {
        ...settings,
        nativeChatProviders: {},
        defaultTuiAgent: 'claude',
        disabledTuiAgents: ['codex']
      },
      repos: [{ ...TEST_REPO, executionHostId: 'runtime:alpha' }],
      runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey('alpha')]: ['claude', 'codex'] },
      ensureRuntimeDetectedAgents: vi.fn().mockResolvedValue(['claude', 'codex']),
      refreshRuntimeDetectedAgents: vi.fn().mockResolvedValue(['claude', 'codex']),
      ensureNativeDetectedAgents: vi.fn()
    })
    const edit = vi.fn()
    const props = {
      repoId: TEST_REPO.id,
      repo: useAppStore.getState().repos[0],
      repoAi: { actionOverrides: actions },
      source: settings.sourceControlAi!,
      defaultTuiAgent: 'claude' as const,
      savingActionIds: {},
      actionDirtyById: computeActionDirtyById({}, {}, {}),
      onActionModeChange: edit,
      onActionAgentChange: edit,
      onActionLaunchPreferencesChange: edit,
      onActionTemplateChange: edit,
      onActionAgentArgsChange: edit,
      onAppendVariable: edit,
      onActionDiscard: edit,
      onActionSave: edit
    }
    const tree = (n: number) =>
      React.createElement(
        TooltipProvider,
        null,
        Array.from({ length: n }, (_, key) =>
          React.createElement(RepositorySourceControlAiActionRows, { ...props, key })
        )
      )
    const view = render(tree(sections))
    try {
      await act(async () => {})
      expect(gets()).toHaveLength(1)
      expect(deadlines()).toHaveLength(1)
      await act(async () => pending.resolve({ settings: host }))
      expect(
        deadlines().every((id) => cleared.mock.calls.some(([clearedId]) => clearedId === id))
      ).toBe(true)
      // Five launch rows plus the three text cards' pickers.
      const previews = () => view.queryAllByRole('button', { name: 'Select agent' })
      expect(previews()).toHaveLength(8 * sections)
      fireEvent.change(view.container.querySelector('textarea')!, { target: { value: 'edited' } })
      expect(gets()).toHaveLength(1)
      view.rerender(tree(1))
      const refresh = Promise.withResolvers<{ settings: typeof host }>()
      rpc.mockImplementation((_target, method) =>
        method === 'settings.getAgentLaunch' ? refresh.promise : Promise.resolve({ settings: host })
      )
      await act(async () => {
        await mutateHostAgentLaunchSettings(
          { environmentId: 'alpha' },
          { type: 'availability', agent: 'claude', enabled: true }
        )
      })
      expect(gets()).toHaveLength(2)
      const signal = gets().at(-1)?.[3].signal
      await act(async () =>
        refresh.resolve({ settings: projectAgentLaunchSettings({ defaultTuiAgent: 'claude' }) })
      )
      expect(previews()).toHaveLength(8)
      rpc.mockImplementation((_target, method) =>
        method === 'settings.getAgentLaunch'
          ? new Promise(() => {})
          : Promise.resolve({ settings: host })
      )
      await act(async () => {
        await mutateHostAgentLaunchSettings(
          { environmentId: 'alpha' },
          { type: 'availability', agent: 'codex', enabled: false }
        )
      })
      view.unmount()
      await act(async () => {})
      expect(signal.aborted).toBe(false)
      expect(gets().at(-1)?.[3].signal.aborted).toBe(true)
      expect(
        deadlines().every((id) => cleared.mock.calls.some(([clearedId]) => clearedId === id))
      ).toBe(true)
    } finally {
      view.unmount()
      timers.mockRestore()
      cleared.mockRestore()
    }
  }
)

it.each(['ssh', 'runtime'] as const)(
  'measures corrected %s twin selectors separately from real action-row renders and disposes their existing request',
  async (kind) => {
    const settings = useAppStore.getState().settings!
    const local: Repo = { ...TEST_REPO, executionHostId: 'local' }
    const exact: Repo =
      kind === 'ssh'
        ? { ...local, path: '/box/repo', connectionId: 'box', executionHostId: 'ssh:box' }
        : { ...local, path: '/alpha/repo', executionHostId: 'runtime:alpha' }
    const ownKey = kind === 'ssh' ? 'box' : getRuntimeAgentInventoryKey('alpha')
    const otherKey = kind === 'ssh' ? 'other' : getRuntimeAgentInventoryKey('other')
    let ownIds: TuiAgent[] = ['claude']
    let ownReads = 0
    let foreignReads = 0
    const inventory = () =>
      Object.defineProperties(
        {},
        {
          [ownKey]: {
            enumerable: true,
            configurable: true,
            get: () => {
              ownReads++
              return ownIds
            }
          },
          [otherKey]: {
            enumerable: true,
            configurable: true,
            get: () => {
              foreignReads++
              return ['goose']
            }
          }
        }
      )
    const remoteRefresh = vi.fn().mockResolvedValue(['claude'])
    const runtimeRefresh = vi.fn().mockResolvedValue(['claude'])
    const host = projectAgentLaunchSettings({ defaultTuiAgent: 'codex' })
    rpc.mockClear()
    rpc.mockResolvedValue({ settings: host })
    useAppStore.setState({
      settings: { ...settings, nativeChatProviders: {}, defaultTuiAgent: 'codex' },
      repos: [local, exact],
      settingsSearchQuery: '',
      detectedAgentIds: ['goose'],
      remoteDetectedAgentIds: kind === 'ssh' ? inventory() : {},
      runtimeDetectedAgentIds: kind === 'runtime' ? inventory() : {},
      ensureNativeDetectedAgents: vi.fn(),
      ensureRemoteDetectedAgents: vi.fn(),
      ensureRuntimeDetectedAgents: vi.fn(),
      refreshRemoteDetectedAgents: remoteRefresh,
      refreshRuntimeDetectedAgents: runtimeRefresh
    })
    const route = vi.spyOn(agentRoute, 'buildAgentLaunchRouteInput')
    const storedInventory = vi.spyOn(agentInventory, 'readDetectedAgentsForTarget')
    const edit = vi.fn()
    let commits = 0
    const view = render(
      React.createElement(
        TooltipProvider,
        null,
        React.createElement(
          React.Profiler,
          {
            id: 'actual-action-rows',
            onRender: () => {
              commits++
            }
          },
          React.createElement(RepositorySourceControlAiActionRows, {
            repoId: exact.id,
            repo: exact,
            repoAi: {},
            source: settings.sourceControlAi!,
            defaultTuiAgent: 'codex',
            savingActionIds: {},
            actionDirtyById: computeActionDirtyById({}, {}, {}),
            onActionModeChange: edit,
            onActionAgentChange: edit,
            onActionLaunchPreferencesChange: edit,
            onActionTemplateChange: edit,
            onActionAgentArgsChange: edit,
            onAppendVariable: edit,
            onActionDiscard: edit,
            onActionSave: edit
          })
        )
      )
    )
    try {
      await act(async () => {})
      const assertHostChoices = async (agent: string, absent: string) => {
        const triggers = view
          .getAllByRole('button', { name: 'Select agent' })
          .filter((button) =>
            SOURCE_CONTROL_LAUNCH_ACTION_IDS.some((id) =>
              button.closest('[data-settings-section]')?.id.endsWith(id)
            )
          )
        expect(triggers).toHaveLength(5)
        fireEvent.pointerDown(triggers[0], { button: 0, ctrlKey: false })
        expect(
          screen.getAllByRole('menuitem').some((row) => row.textContent?.includes(agent))
        ).toBe(true)
        expect(
          screen.getAllByRole('menuitem').some((row) => row.textContent?.includes(absent))
        ).toBe(false)
        fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
        await act(async () => {})
      }
      expect(view.getAllByRole('button', { name: 'Select agent' })).toHaveLength(8)
      expect(kind === 'ssh' ? remoteRefresh : runtimeRefresh).toHaveBeenCalledWith(
        kind === 'ssh' ? 'box' : 'alpha',
        ...(kind === 'runtime' ? [undefined] : [])
      )
      expect(kind === 'ssh' ? runtimeRefresh : remoteRefresh).not.toHaveBeenCalled()
      const expectedTarget =
        kind === 'ssh'
          ? { kind: 'ssh', connectionId: 'box' }
          : { kind: 'runtime', environmentId: 'alpha' }
      expect(storedInventory.mock.calls.length).toBeGreaterThan(0)
      expect(
        storedInventory.mock.calls.every(
          ([, target]) => JSON.stringify(target) === JSON.stringify(expectedTarget)
        )
      ).toBe(true)
      const repositoryRoutes = () =>
        route.mock.calls.filter(([, args]) => args.workspace.repoId === exact.id)
      expect(repositoryRoutes().length).toBeGreaterThan(0)
      expect(
        repositoryRoutes().every(
          ([, args]) => args.workspace.executionHostId === exact.executionHostId
        )
      ).toBe(true)
      const gets = () => rpc.mock.calls.filter((call) => call[1] === 'settings.getAgentLaunch')
      expect(gets()).toHaveLength(kind === 'runtime' ? 1 : 0)
      async function measure(label: string, publish: () => void) {
        commits = ownReads = foreignReads = 0
        route.mockClear()
        storedInventory.mockClear()
        await act(async () => publish())
        const record = {
          kind,
          act: label,
          commits,
          ownInventoryReads: ownReads,
          foreignInventoryReads: foreignReads,
          storedInventoryReads: storedInventory.mock.calls.length,
          routePreparations: repositoryRoutes().length,
          hostRequests: gets().length
        }
        console.log('PG9 nested action selectors', JSON.stringify(record))
        expect(record.ownInventoryReads).toBeGreaterThan(0)
        expect(record.storedInventoryReads).toBeGreaterThan(0)
        expect(record.routePreparations).toBeGreaterThan(0)
        expect(record.foreignInventoryReads).toBe(0)
        expect(
          repositoryRoutes().every(
            ([, args]) => args.workspace.executionHostId === exact.executionHostId
          )
        ).toBe(true)
        expect(gets()).toHaveLength(kind === 'runtime' ? 1 : 0)
        return record
      }
      const unrelated = await measure('unrelated', () =>
        useAppStore.setState({ settingsSearchInputQuery: 'unrelated notification' })
      )
      expect(unrelated.commits).toBe(0)
      const font = await measure('font', () =>
        useAppStore.setState(({ settings }) => ({
          settings: settings && { ...settings, appFontFamily: 'monospace' }
        }))
      )
      expect(font.commits).toBe(0)
      const otherHost = await measure('other-host', () =>
        useAppStore.setState(
          kind === 'ssh'
            ? {
                remoteDetectedAgentIds: Object.defineProperty(inventory(), otherKey, {
                  enumerable: true,
                  configurable: true,
                  value: ['codex']
                })
              }
            : {
                runtimeDetectedAgentIds: Object.defineProperty(inventory(), otherKey, {
                  enumerable: true,
                  configurable: true,
                  value: ['codex']
                })
              }
        )
      )
      expect(otherHost.commits).toBe(0)
      const equalOverride = await measure('equal-override', () =>
        useAppStore.setState(({ settings }) => ({
          settings: settings && {
            ...settings,
            projectGroupingOverrides: { ...settings.projectGroupingOverrides }
          }
        }))
      )
      expect(equalOverride.commits).toBe(0)
      const meaningful = await measure('same-owner-inventory', () => {
        ownIds = ['codex']
        useAppStore.setState(
          kind === 'ssh'
            ? { remoteDetectedAgentIds: inventory() }
            : { runtimeDetectedAgentIds: inventory() }
        )
      })
      expect(meaningful.commits).toBeGreaterThan(0)
      await assertHostChoices('Codex', 'Claude')
      expect(edit).not.toHaveBeenCalled()
      view.unmount()
      await act(async () => {})
      const readsAfterUnmount = ownReads
      const routesAfterUnmount = route.mock.calls.length
      act(() => useAppStore.setState({ settingsSearchInputQuery: 'after retirement' }))
      expect(ownReads).toBe(readsAfterUnmount)
      expect(route).toHaveBeenCalledTimes(routesAfterUnmount)
    } finally {
      view.unmount()
      route.mockRestore()
      storedInventory.mockRestore()
    }
  }
)
registerRepoSourceExtentTests(rpc)

registerRepositoryStagedSetupTest()
