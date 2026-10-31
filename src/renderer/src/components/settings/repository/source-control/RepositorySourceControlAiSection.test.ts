// @vitest-environment happy-dom
import { EVERY_AGENT_CHAT } from '../../../../../../shared/native-chat/every-agent-chat.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, cleanup, fireEvent } from '@testing-library/react'
import '../../__fixtures__/settings-persistence-test-fixture'
import React from 'react'
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
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
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
  useAppStore.getState().clearLocalDetectedAgents()
  const settings = useAppStore.getState().settings!
  useAppStore.setState({
    settings: { ...settings, nativeChatProviders: {} }
  })
  type DetectAgents = Window['api']['preflight']['detectAgents']
  const reply = Promise.withResolvers<Awaited<ReturnType<DetectAgents>>>()
  const detected: Awaited<ReturnType<DetectAgents>> = ['claude']
  const detectAgents = vi.spyOn(window.api.preflight, 'detectAgents').mockReturnValue(reply.promise)
  const expectedContext = getLocalAgentPreflightContext(useAppStore.getState())
  const originalEnsure = useAppStore.getState().ensureDetectedAgents
  const ensure = vi.spyOn(useAppStore.getState(), 'ensureDetectedAgents')
  const onPick = vi.fn()
  const picker = (agent: 'codex' | null) =>
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(SourceControlActionAgentPicker, { agent, onPick })
    )
  let view: ReturnType<typeof render> | undefined
  try {
    expect(useAppStore.getState().detectedAgentIds).toBeNull()
    view = render(picker(null))
    expect(view.getByRole('combobox').hasAttribute('disabled')).toBe(true)
    view.rerender(picker('codex'))
    expect(view.getByRole('combobox').hasAttribute('disabled')).toBe(true)
    expect(ensure).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(detectAgents).toHaveBeenCalledExactlyOnceWith({ ...expectedContext, enabledOnly: true })
    expect(useAppStore.getState().readLocalAgentInventory()).toEqual({
      ids: null,
      state: 'pending'
    })
    await act(async () => {
      reply.resolve(detected)
      const completed = await Promise.all(
        ensure.mock.results.map((result) => {
          if (result.type !== 'return') {
            throw new Error('Expected the real inventory owner to return its settlement promise')
          }
          return result.value
        })
      )
      expect(completed).toEqual([['claude']])
    })
    expect(useAppStore.getState().readLocalAgentInventory()).toEqual({
      ids: ['claude'],
      state: 'successful'
    })
    expect(useAppStore.getState().detectedAgentIds).toEqual(['claude'])
    expect(view.getByRole('combobox').hasAttribute('disabled')).toBe(false)
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('combobox'))
    const available = view.getAllByRole('option').find((row) => row.textContent?.includes('Claude'))
    expect(available).toBeDefined()
    fireEvent.click(available!)
    expect(onPick).toHaveBeenCalledWith('claude', {})
  } finally {
    try {
      await act(async () => {
        try {
          if (view) {
            view.unmount()
          } else {
            cleanup()
          }
        } finally {
          reply.resolve(detected)
          const drained = await Promise.allSettled(
            ensure.mock.results.flatMap((result) =>
              result.type === 'return' ? [result.value] : []
            )
          )
          expect(drained).toEqual([{ status: 'fulfilled', value: ['claude'] }])
          expect(ensure.mock.results.map((result) => result.type)).toEqual(['return'])
        }
      })
    } finally {
      try {
        useAppStore.getState().clearLocalDetectedAgents()
      } finally {
        try {
          detectAgents.mockRestore()
        } finally {
          try {
            ensure.mockRestore()
          } finally {
            useAppStore.setState({ ensureDetectedAgents: originalEnsure })
          }
        }
      }
    }
  }
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

it('opens the global unset recipe list after cold failure and persists the complete command through its writer', async () => {
  const base = useAppStore.getState().settings!
  useAppStore.getState().clearLocalDetectedAgents()
  useAppStore.setState({
    settingsSearchQuery: '',
    settings: {
      ...base,
      defaultTuiAgent: 'blank',
      agentDefaultSurface: 'terminal',
      nativeChatProviders: {},
      sourceControlAi: {
        ...base.sourceControlAi!,
        enabled: true,
        actions: {
          fixChecks: {
            agentId: null,
            agentArgs: '--verbose',
            commandInputTemplate: 'fix {basePrompt}'
          }
        }
      }
    }
  })
  window.api.preflight.detectAgents = vi.fn().mockRejectedValue(new Error('login capture failed'))
  await useAppStore.getState().ensureDetectedAgents()
  function Defaults() {
    const settings = useAppStore((state) => state.settings)!
    return React.createElement(SourceControlAiActionRecipeDefaults, {
      config: settings.sourceControlAi!,
      defaultTuiAgent: settings.defaultTuiAgent,
      searchQuery: '',
      writeConfig: async (patch) => {
        const current = useAppStore.getState().settings!.sourceControlAi!
        const updates = typeof patch === 'function' ? patch(current) : patch
        await useAppStore.getState().updateSettings({ sourceControlAi: { ...current, ...updates } })
      }
    })
  }
  const view = render(React.createElement(TooltipProvider, null, React.createElement(Defaults)))
  await act(async () => {})
  const row = view.getByText('Broken checks fixes').parentElement?.parentElement?.parentElement
  if (!(row instanceof HTMLElement)) {
    throw new Error('Missing global Checks recipe')
  }
  const { within } = await import('@testing-library/react')
  expect(within(row).getByRole('combobox').textContent).toContain('Use default agent')
  await act(async () => fireEvent.click(within(row).getByRole('combobox')))
  const command = view
    .getAllByRole('option')
    .find((option) => option.textContent?.startsWith('Claude'))
  if (!command) {
    throw new Error('Missing configured command')
  }
  await act(async () => fireEvent.click(command))
  expect(useAppStore.getState().settings?.sourceControlAi?.actions?.fixChecks).toMatchObject({
    agentId: 'claude',
    agentArgs: '--verbose',
    commandInputTemplate: 'fix {basePrompt}'
  })
  expect(useAppStore.getState().readLocalAgentInventory()).toEqual({ ids: null, state: 'failed' })
})
