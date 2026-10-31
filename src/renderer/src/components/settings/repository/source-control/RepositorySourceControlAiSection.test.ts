// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, cleanup, fireEvent } from '@testing-library/react'
import '../../__fixtures__/settings-persistence-test-fixture'
import React from 'react'
import * as agentRoute from '@/lib/agent-launch-route-input'
import * as agentInventory from '@/lib/agent-detection-target-inventory'
import type { Repo } from '../../../../../../shared/repo-types'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import { normalizeRepoSourceControlAiOverrides } from '../../../../../../shared/source-control-ai-repo-settings'
import type { RepoSourceControlAiOverrides } from '../../../../../../shared/source-control-ai-types'
import { setSourceControlActionAgentDefault } from '../../../../../../shared/source-control-ai-actions'
import {
  computeActionDirtyById,
  dropRepoLegacyInstructionForAction,
  withRepoAiActionMode
} from './repository-source-control-ai-draft'
import { withRepoAiActionAgent } from '../../repository-source-control-ai-action-agent-draft'
import { resolveSourceControlActionRecipe } from '../../../../../../shared/source-control-ai-operation-policy'
import {
  saveSourceControlActionRecipe,
  toSourceControlAiRepoUpdate
} from '../../../../../../shared/source-control-ai-recipe-save'
import { sourceControlActionRecipeMatchesTarget } from '../../../right-sidebar/source-control-action-recipe-match'
import { SourceControlActionAgentPicker } from '../../SourceControlActionAgentPicker'
import { RepositorySourceControlAiActionRows } from './RepositorySourceControlAiActionRows'
import { SourceControlAiActionRecipeDefaults } from '../../SourceControlAiActionRecipeDefaults'
import { useAppStore } from '../../../../store/index'
import { TooltipProvider } from '../../../ui/tooltip'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { projectAgentLaunchSettings } from '../../../../../../shared/agent-launch-settings'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { clearHostAgentMenuSettingsForTests } from '../../use-host-agent-launch-preferences'
import { mutateHostAgentLaunchSettings } from '../../agent-launch-settings-transport'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { resetHostStructuredAgentsForTests } from '@/runtime/host-structured-agents'
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
      for (const card of cards) {
        expect(card.textContent).toContain('Model')
        expect(card.textContent).toContain('Permissions')
        expect(card.textContent).toContain('Ask')
        expect(card.querySelector('button[aria-label="saved"]')).not.toBeNull()
        const controls = Array.from(
          card.querySelectorAll<HTMLButtonElement>(
            'button[role="combobox"].min-w-0, button[aria-haspopup="menu"]'
          )
        )
        expect(controls.length).toBeGreaterThan(0)
        expect(controls.every((control) => control.disabled)).toBe(true)
        expect(card.querySelector('textarea[aria-label="Arguments"]')).toBeNull()
      }
      await act(async () => {
        finish([...detected])
      })
      for (const card of cards) {
        const controls = Array.from(
          card.querySelectorAll<HTMLButtonElement>(
            'button[role="combobox"].min-w-0, button[aria-haspopup="menu"]'
          )
        )
        expect(controls.length).toBeGreaterThan(0)
        expect(controls.every((control) => !control.disabled)).toBe(true)
        expect(card.textContent).toContain('Model')
        expect(card.textContent?.includes('Reasoning effort')).toBe(agent === 'codex')
        expect(card.textContent).toContain('Permissions')
        expect(
          card.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')?.value
        ).toBe(surface === 'chat' ? undefined : '--saved-cli')
        expect(
          Array.from(card.querySelectorAll('textarea')).some(
            (field) => field.value === 'kept-template'
          )
        ).toBe(true)
      }
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
          const input = card.querySelector<HTMLTextAreaElement>('textarea[aria-label="Arguments"]')
          expect(input?.value).toBe(
            surface === 'terminal'
              ? '--saved-cli'
              : surface === 'chat' || (chat && agent !== 'opencode')
                ? undefined
                : '--saved-cli'
          )
        }
      }
      expect(JSON.stringify(source.actions.fixCommitFailure)).toBe(originalRecipe)
      expect(writeConfig).not.toHaveBeenCalled()
      expect(onEdit).not.toHaveBeenCalled()
    }
  )
})

describe('dropRepoLegacyInstructionForAction', () => {
  it('prevents legacy text instructions from remigrating after an action override is cleared', () => {
    const next = dropRepoLegacyInstructionForAction(
      {
        instructionsByOperation: {
          commitMessage: 'Use repo style.',
          pullRequest: 'Use PR style.'
        },
        actionOverrides: {}
      },
      'commitMessage'
    )

    expect(next.instructionsByOperation).toEqual({ pullRequest: 'Use PR style.' })
    const normalized = normalizeRepoSourceControlAiOverrides(next)
    expect(normalized?.actionOverrides?.commitMessage).toBeUndefined()
    expect(normalized?.actionOverrides?.pullRequest).toEqual({
      commandInputTemplate: '{basePrompt}\n\nUse PR style.'
    })
  })
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
  expect(view.getByRole('combobox').hasAttribute('disabled')).toBe(true)
  view.rerender(picker('codex'))
  expect(view.getByRole('combobox').hasAttribute('disabled')).toBe(true)
  await act(async () => useAppStore.setState({ detectedAgentIds: ['claude'] }))
  expect(view.getByRole('combobox').hasAttribute('disabled')).toBe(false)
  expect(onPick).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('combobox'))
  const available = view.getAllByRole('option').find((row) => row.textContent?.includes('Claude'))
  expect(available).toBeDefined()
  fireEvent.click(available!)
  expect(onPick).toHaveBeenCalledWith('claude', {})
})

it.each([1, 10])(
  'shares one host request lifetime across %i real Settings sections and all five launch rows',
  async (sections) => {
    vi.useFakeTimers()
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
      const previews = () => view.queryAllByRole('button', { name: 'Codex permissions' })
      expect(previews()).toHaveLength(5 * sections)
      fireEvent.change(view.container.querySelector('textarea')!, { target: { value: 'edited' } })
      fireEvent.change(view.container.querySelector('textarea[aria-label="Arguments"]')!, {
        target: { value: '--edited' }
      })
      fireEvent.pointerDown(previews()[0], { button: 0, ctrlKey: false })
      fireEvent.click(view.getByRole('menuitemradio', { name: /^Ask/ }))
      expect(edit).toHaveBeenCalledWith(
        'fixCommitFailure',
        expect.objectContaining({ agentId: 'codex' }),
        undefined,
        null
      )
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
      expect(previews()).toHaveLength(0)
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
      vi.useRealTimers()
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
      settings: { ...settings, experimentalNativeChat: false, defaultTuiAgent: 'codex' },
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
      const permissions = (agent: string) =>
        view.queryAllByRole('button', { name: `${agent} permissions` })
      expect(permissions('Claude')).toHaveLength(5)
      expect(permissions('Goose')).toHaveLength(0)
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
      expect(
        route.mock.calls.every(
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
          routePreparations: route.mock.calls.length,
          hostRequests: gets().length
        }
        console.log('PG9 nested action selectors', JSON.stringify(record))
        expect(record.ownInventoryReads).toBeGreaterThan(0)
        expect(record.storedInventoryReads).toBeGreaterThan(0)
        expect(record.routePreparations).toBeGreaterThan(0)
        expect(record.foreignInventoryReads).toBe(0)
        expect(
          route.mock.calls.every(
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
      expect(font.commits).toBeGreaterThan(0)
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
      expect(equalOverride.commits).toBeGreaterThan(0)
      expect(permissions('Claude')).toHaveLength(5)
      const meaningful = await measure('same-owner-inventory', () => {
        ownIds = ['codex']
        useAppStore.setState(
          kind === 'ssh'
            ? { remoteDetectedAgentIds: inventory() }
            : { runtimeDetectedAgentIds: inventory() }
        )
      })
      expect(meaningful.commits).toBeGreaterThan(0)
      expect(permissions('Codex')).toHaveLength(5)
      expect(permissions('Claude')).toHaveLength(0)
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
