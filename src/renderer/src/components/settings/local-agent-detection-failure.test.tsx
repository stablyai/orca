// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, within } from '@testing-library/react'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import type { AppState } from '@/store/types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { type ComponentProps, Profiler, useState } from 'react'
import * as runtime from '../../../../shared/project-execution-runtime'
import { useLocalAgentPreflightContext } from '@/hooks/useLocalAgentPreflightContext'
import { localAgentInventoryContextKey } from '@/lib/local-preflight-context-key'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import { useRepositorySourceControlAiGlobalUx } from './repository/source-control/repository-source-control-ai-global-ux'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { useAppStore } from '@/store'
import { AgentLaunchSettingsCatalog } from './AgentLaunchSettingsCatalog'
import { OrchestrationSkillAgentCoverage } from './OrchestrationSkillAgentCoverage'
import { useSourceControlActionAgent } from './use-source-control-action-agent'
import { RepositorySourceControlAiActionRows } from './repository/source-control/RepositorySourceControlAiActionRows'
import { getDefaultSourceControlAiSettings } from '../../../../shared/source-control-ai'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentStep } from '../onboarding/AgentStep'
import {
  exerciseNativeInventoryRetryWhileProviderSavePending,
  exerciseQueuedNativeProviderSave
} from './native-agent-provider-save.test-fixture'

vi.mock('@/lib/host-chat-program-acquisition', () => ({ useChatProgramFacts: () => {} }))
vi.mock('@/runtime/use-managed-runtime-install', () => ({
  useManagedRuntimeInstall: () => ({ kind: 'inactive' })
}))
vi.mock('@/lib/chat-provider-agents', () => ({
  chatProviderAgents: () => ['claude', 'codex', 'grok'],
  useHostStructuredAgentsVersion: () => 0
}))
vi.mock('./AntigravityChatSignInRow', () => ({ useAntigravityChatSignIn: () => ({ flow: null }) }))
const initial = useAppStore.getInitialState()
const detectAgents = vi.fn()
const refreshAgents = vi.fn<Window['api']['preflight']['refreshAgents']>()
beforeEach(() => {
  useAppStore.setState(initial, true)
  useAppStore.getState().clearLocalDetectedAgents()
  detectAgents.mockReset().mockRejectedValue(new Error('probe failed'))
  refreshAgents.mockReset().mockResolvedValue({
    agents: ['claude'],
    addedPathSegments: [],
    shellHydrationOk: true,
    pathSource: 'shell_hydrate',
    pathFailureReason: 'none'
  })
  Object.assign(window, {
    api: {
      preflight: { detectAgents, refreshAgents },
      platform: { get: () => ({ platform: 'win32' }) }
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.getState().clearLocalDetectedAgents()
  useAppStore.setState(initial, true)
})

it('shows a native failure and retries the native host even with a global WSL default', async () => {
  let settings: GlobalSettings = {
    ...getDefaultSettings('/tmp'),
    experimentalNativeChat: true,
    localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
  }
  const owned: Promise<unknown>[] = []
  const save = Promise.withResolvers<void>()
  const reply =
    Promise.withResolvers<Awaited<ReturnType<Window['api']['preflight']['refreshAgents']>>>()
  const originalEnsure = useAppStore.getState().ensureAllDetectedAgents
  const originalRefresh = useAppStore.getState().refreshDetectedAgents
  const ensureAll: AppState['ensureAllDetectedAgents'] = (...args) => {
    const pending = originalEnsure(...args)
    owned.push(pending)
    return pending
  }
  const refreshNative: AppState['refreshDetectedAgents'] = (...args) => {
    const pending = originalRefresh(...args)
    owned.push(pending)
    return pending
  }
  const update = vi.fn((updates: Partial<GlobalSettings>) => {
    const pending = save.promise.then(() => {
      settings = { ...settings, ...updates }
      useAppStore.setState({ settings })
    })
    owned.push(pending)
    return pending
  })
  useAppStore.setState({
    settings,
    ensureAllDetectedAgents: ensureAll,
    refreshDetectedAgents: refreshNative
  })
  const native = useAppStore.getState().ensureNativeDetectedAgents()
  owned.push(native)
  let view: ReturnType<typeof render> | undefined
  let scheduled = 0
  try {
    await native
    expect(useAppStore.getState().readLocalAgentInventory(FLOATING_TERMINAL_WORKTREE_ID)).toEqual({
      ids: null,
      state: 'failed'
    })
    view = render(
      <AgentLaunchSettingsCatalog
        settings={projectAgentLaunchSettings(settings)}
        mutate={vi.fn(async () => {})}
        detectionTarget={{ kind: 'local' }}
        hostName={null}
        renderPermissions={() => null}
        local={{ settings, updateSettings: update, saveEnvironment: vi.fn(async () => {}) }}
      />,
      { wrapper: TooltipProvider }
    )
    await act(async () => {
      await Promise.allSettled(owned)
    })
    const targetKey = 'local-project:wsl:Ubuntu\u0000all-agents'
    const targetBefore = useAppStore.getState().readLocalAgentInventoryByKey(targetKey)
    expect(targetBefore).toEqual({ ids: null, state: 'failed' })
    expect(
      view.queryAllByText(/Couldn't check which agents are installed on this computer/)
    ).toHaveLength(2)
    expect(view.queryAllByRole('button', { name: 'Retry' })).toHaveLength(2)
    expect(
      view.getByText("Couldn't check which agents are installed on this computer. Try again.")
    ).toBeTruthy()
    expect(detectAgents.mock.calls).toEqual([
      [{ enabledOnly: true }],
      [
        {
          wslDistro: 'Ubuntu',
          projectRuntime: {
            status: 'resolved',
            runtime: {
              kind: 'wsl',
              hostPlatform: 'wsl',
              projectId: 'local-project',
              distro: 'Ubuntu',
              reason: 'global-default',
              cacheKey: 'local-project:wsl:Ubuntu'
            }
          }
        }
      ]
    ])
    expect(view.queryByText('Not installed')).toBeNull()
    const claude = view.getByRole('radiogroup', { name: 'Open Claude as' })
    const codex = view.getByRole('radiogroup', { name: 'Open Codex as' })
    const grok = view.getByRole('radiogroup', { name: 'Open Grok as' })
    expect(
      within(claude).getByRole('radio', { name: 'Chat' }).getAttribute('aria-disabled')
    ).not.toBe('true')
    expect(within(codex).getByRole('radio', { name: 'Chat' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(
      within(codex).getByRole('radio', { name: 'Chat' }).getAttribute('aria-disabled')
    ).not.toBe('true')
    expect(within(grok).getByRole('radio', { name: 'Chat' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    expect(update).not.toHaveBeenCalled()
    expect(settings.nativeChatProviders).toBeUndefined()
    scheduled++
    fireEvent.click(within(codex).getByRole('radio', { name: 'CLI' }))
    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce())
    expect(settings.nativeChatProviders).toBeUndefined()
    refreshAgents.mockImplementationOnce(() => reply.promise)
    const notice = view.getByText(/Couldn't check which agents are installed on this computer.*·/)
    await act(async () => {
      fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }))
    })
    expect(useAppStore.getState().isRefreshingLocalAgentsByContext.host).toBe(true)
    expect(
      view.queryByText(/Couldn't check which agents are installed on this computer.*·/)
    ).toBeNull()
    expect(useAppStore.getState().readLocalAgentInventoryByKey(targetKey)).toEqual(targetBefore)
    expect(
      view.queryAllByText(/Couldn't check which agents are installed on this computer/)
    ).toHaveLength(1)
    expect(view.queryAllByRole('button', { name: 'Retry' })).toHaveLength(1)
    expect(
      view.getByText("Couldn't check which agents are installed on this computer. Try again.")
    ).toBeTruthy()
    await act(async () => {
      reply.reject(new Error('retry still unavailable'))
      await Promise.allSettled(owned.filter((pending) => pending !== update.mock.results[0].value))
    })
    const retryNotice = view.getByText(
      /Couldn't check which agents are installed on this computer.*·/
    )
    expect(
      view.queryAllByText(/Couldn't check which agents are installed on this computer/)
    ).toHaveLength(2)
    expect(view.queryAllByRole('button', { name: 'Retry' })).toHaveLength(2)
    expect(
      view.getByText("Couldn't check which agents are installed on this computer. Try again.")
    ).toBeTruthy()
    expect(settings.nativeChatProviders).toBeUndefined()
    expect(detectAgents).toHaveBeenCalledTimes(2)
    await act(async () => {
      fireEvent.click(within(retryNotice).getByRole('button', { name: 'Retry' }))
      await Promise.allSettled(owned.filter((pending) => pending !== update.mock.results[0].value))
    })
    expect(refreshAgents.mock.calls).toEqual([[{ enabledOnly: true }], [{ enabledOnly: true }]])
    expect(useAppStore.getState().readLocalAgentInventory(FLOATING_TERMINAL_WORKTREE_ID)).toEqual({
      ids: ['claude'],
      state: 'successful'
    })
    expect(
      view.queryByText(/Couldn't check which agents are installed on this computer.*·/)
    ).toBeNull()
    expect(useAppStore.getState().readLocalAgentInventoryByKey(targetKey)).toEqual(targetBefore)
    expect(
      view.queryAllByText(/Couldn't check which agents are installed on this computer/)
    ).toHaveLength(1)
    expect(view.queryAllByRole('button', { name: 'Retry' })).toHaveLength(1)
    expect(
      view.getByText("Couldn't check which agents are installed on this computer. Try again.")
    ).toBeTruthy()
    expect(settings.nativeChatProviders).toBeUndefined()
    await act(async () => {
      save.resolve()
      await Promise.allSettled(owned)
    })
    expect(settings.nativeChatProviders).toEqual({ codex: false })
    expect(useAppStore.getState().settings?.nativeChatProviders).toEqual({ codex: false })
  } finally {
    view?.unmount()
    save.resolve()
    reply.reject(new Error('native reply released during teardown'))
    try {
      await act(async () => {
        await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(scheduled))
        await Promise.allSettled(owned)
      })
    } finally {
      useAppStore.getState().clearLocalDetectedAgents()
      useAppStore.setState({
        ensureAllDetectedAgents: originalEnsure,
        refreshDetectedAgents: originalRefresh
      })
    }
  }
})

it('shows one native inventory failure while provider saves and all-mode Retry settle', async () => {
  await exerciseNativeInventoryRetryWhileProviderSavePending(refreshAgents)
})

it.each([true, false])(
  'keeps an explicit provider choice %s operable after detection fails',
  async (choice) => {
    const owned: Promise<unknown>[] = []
    const originalEnsure = useAppStore.getState().ensureAllDetectedAgents
    const originalApi = window.api
    const native = useAppStore.getState().ensureNativeDetectedAgents()
    owned.push(native)
    const settings = {
      ...getDefaultSettings('/tmp'),
      experimentalNativeChat: true,
      nativeChatProviders: { grok: choice }
    }
    Object.assign(window, {
      api: { ...window.api, settings: { get: vi.fn(async () => settings) } }
    })
    const ensureAll: AppState['ensureAllDetectedAgents'] = (...args) => {
      const pending = originalEnsure(...args)
      owned.push(pending)
      return pending
    }
    useAppStore.setState({
      settings: null,
      hydrateRuntimeEnvironmentStatuses: vi.fn(),
      ensureAllDetectedAgents: ensureAll
    })
    let view: ReturnType<typeof render> | undefined
    try {
      await native
      const fetched = useAppStore.getState().fetchSettings()
      owned.push(fetched)
      await fetched
      expect(useAppStore.getState().settings?.nativeChatProviders).toEqual({ grok: choice })
      const update = vi.fn((updates: Partial<GlobalSettings>) => {
        const pending = Promise.resolve().then(() => {
          useAppStore.setState({ settings: { ...settings, ...updates } })
        })
        owned.push(pending)
        return pending
      })
      view = render(
        <AgentLaunchSettingsCatalog
          settings={projectAgentLaunchSettings(settings)}
          mutate={vi.fn(async () => {})}
          detectionTarget={{ kind: 'local' }}
          hostName={null}
          renderPermissions={() => null}
          local={{ settings, updateSettings: update, saveEnvironment: vi.fn(async () => {}) }}
        />,
        { wrapper: TooltipProvider }
      )
      await act(async () => {
        await Promise.allSettled(owned)
      })
      const control = view.getByRole('radiogroup', { name: 'Open Grok as' })
      const chosen = within(control).getByRole('radio', { name: choice ? 'Chat' : 'CLI' })
      expect(chosen.getAttribute('aria-checked')).toBe('true')
      expect(chosen.getAttribute('aria-disabled')).not.toBe('true')
      await act(async () => {
        fireEvent.click(within(control).getByRole('radio', { name: choice ? 'CLI' : 'Chat' }))
      })
      expect(update).toHaveBeenCalledWith({ nativeChatProviders: { grok: !choice } })
      expect(useAppStore.getState().settings?.nativeChatProviders).toEqual({ grok: !choice })
    } finally {
      view?.unmount()
      await act(async () => {
        await Promise.allSettled(owned)
      })
      useAppStore.getState().clearLocalDetectedAgents()
      useAppStore.setState({ ensureAllDetectedAgents: originalEnsure })
      Object.assign(window, { api: originalApi })
    }
  }
)

it(
  'preserves clicked provider choices while queued saves and inventory changes settle',
  exerciseQueuedNativeProviderSave
)

it('settles Source Control arguments after an unknown native inventory fails', async () => {
  const { result } = renderHook(() => useSourceControlActionAgent(null, 'claude'))
  expect(result.current.status).toBe('pending')
  await act(async () => {
    await useAppStore.getState().ensureNativeDetectedAgents()
  })
  expect(result.current).toMatchObject({ status: 'ready', agent: null })
})

it('ends skill coverage loading with a failure instead of an empty inventory', async () => {
  const view = render(<OrchestrationSkillAgentCoverage skills={[]} sources={[]} loading={false} />)
  await act(async () => {})
  expect(view.queryByText(/Checking installed/)).toBeNull()
  expect(view.queryByText(/No agent CLIs/)).toBeNull()
  expect(view.getByText(/Couldn't check which agents/)).toBeTruthy()
})

it('recovers the cold catalog through Retry and keeps retained rows editable after failed refresh', async () => {
  const mutate = vi.fn<ComponentProps<typeof AgentLaunchSettingsCatalog>['mutate']>(async () => {})
  const view = render(
    <TooltipProvider>
      <AgentLaunchSettingsCatalog
        settings={projectAgentLaunchSettings(getDefaultSettings('/tmp'))}
        mutate={mutate}
        detectionTarget={{ kind: 'local' }}
        hostName={null}
        renderPermissions={() => null}
      />
    </TooltipProvider>
  )
  await act(async () => {})
  expect(view.queryByText('Available to install')).toBeNull()
  expect(view.queryByText('Detecting agents…')).toBeNull()
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
  })
  expect(view.getByText('Installed')).toBeTruthy()
  expect(view.getByRole('radiogroup', { name: 'Claude availability' })).toBeTruthy()
  expect(view.queryByRole('button', { name: 'Retry' })).toBeNull()
  refreshAgents.mockRejectedValue(new Error('refresh failed'))
  await act(async () => {
    await useAppStore.getState().refreshAllDetectedAgents()
  })
  expect(view.getAllByText('Claude').length).toBeGreaterThan(0)
  const availability = view.getByRole('radiogroup', { name: 'Claude availability' })
  await act(async () => {
    fireEvent.click(within(availability).getByRole('radio', { name: /Disabled/ }))
  })
  expect(mutate).toHaveBeenCalled()
  expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy()
  expect(view.queryByText(/Check the host connection/)).toBeNull()
})

it.each([false, true])(
  'repository recipe new-choice=%s and permission editing settle after cold rejection',
  async (newChoice) => {
    useAppStore.setState({
      repos: [TEST_REPO],
      settings: {
        ...getDefaultSettings('/tmp'),
        experimentalNativeChat: false,
        defaultTuiAgent: 'blank'
      }
    })
    let saved: RepoSourceControlAiOverrides = {
      actionOverrides: {
        fixChecks: {
          agentId: newChoice ? null : 'claude',
          ...(newChoice ? {} : { surface: 'terminal' as const }),
          commandInputTemplate: '{basePrompt}',
          agentArgs: '--verbose'
        }
      }
    }
    function RepositoryRecipes() {
      const [persisted, setPersisted] = useState(saved)
      const draft = useRepositorySourceControlAiGlobalUx({
        repoId: TEST_REPO.id,
        persistedRepoAi: persisted,
        settings: getDefaultSettings('/tmp'),
        source: getDefaultSourceControlAiSettings(),
        updateRepo: async (_id, patch) => {
          saved = patch.sourceControlAi ?? {}
          setPersisted(saved)
          return true
        }
      })
      return (
        <RepositorySourceControlAiActionRows
          repoId={TEST_REPO.id}
          repoAi={draft.displayRepoAi}
          source={getDefaultSourceControlAiSettings()}
          defaultTuiAgent="claude"
          onActionModeChange={draft.updateActionMode}
          onActionAgentChange={draft.updateActionAgent}
          onActionLaunchPreferencesChange={draft.updateActionLaunchPreferences}
          onActionTemplateChange={draft.updateActionTemplate}
          onActionAgentArgsChange={draft.updateActionAgentArgs}
          onAppendVariable={draft.appendVariable}
          savingActionIds={draft.savingActionIds}
          actionDirtyById={draft.actionDirtyById}
          onActionDiscard={draft.discardActionRecipeText}
          onActionSave={draft.saveActionRecipeText}
        />
      )
    }
    const view = render(
      <TooltipProvider>
        <RepositoryRecipes />
      </TooltipProvider>
    )
    await act(async () => {})
    const row = view.container.querySelector(
      '[data-settings-section$="source-control-ai-fixChecks"]'
    )
    if (!(row instanceof HTMLElement)) {
      throw new Error('Missing saved Checks row')
    }
    if (newChoice) {
      expect(
        within(row)
          .getAllByRole('combobox')
          .find((element) => element.hasAttribute('data-agent-combobox-root'))!.textContent
      ).toContain('Use default agent')
      await userEvent.click(
        within(row)
          .getAllByRole('combobox')
          .find((element) => element.hasAttribute('data-agent-combobox-root'))!
      )
      const command = view
        .getAllByRole('option')
        .find((option) => option.textContent?.startsWith('Claude'))
      if (!command) {
        throw new Error('Missing cold configuration command')
      }
      await userEvent.click(command)
    }
    expect(useAppStore.getState().readLocalAgentInventory()).toEqual({ ids: null, state: 'failed' })
    const editable = within(row).getByRole('button', { name: 'Claude permissions' })
    expect(editable.hasAttribute('disabled')).toBe(false)
    await userEvent.click(editable)
    const options = await view.findAllByRole('menuitemradio', { name: /Full access/ })
    const option = options.find((entry) => entry.getAttribute('aria-checked') === 'false')
    if (!option) {
      throw new Error('Missing explicit Full access choice')
    }
    await userEvent.click(option)
    await act(async () => {
      fireEvent.click(within(row).getByRole('button', { name: 'Save' }))
    })
    expect(saved.actionOverrides?.fixChecks).toMatchObject({
      agentId: 'claude',
      ...(newChoice ? {} : { surface: 'terminal' }),
      agentArgs: '--verbose',
      commandInputTemplate: '{basePrompt}',
      launchPreferences: { agentId: 'claude', permissionMode: 'full-access' }
    })
  }
)

it('onboarding and setup checklist retain selection, continue and save after failed discovery', async () => {
  const { default: OnboardingFlow } = await import('../onboarding/OnboardingFlow')
  const { getDefaultOnboardingState } = await import('../../../../shared/onboarding-defaults')
  const { FeatureWallSetupChecklist } = await import('../feature-wall/FeatureWallSetupChecklist')
  const { FEATURE_WALL_SETUP_STEPS } = await import('../../../../shared/feature-wall-setup-steps')
  const update = vi.fn<AppState['updateSettings']>(async (patch) => {
    useAppStore.setState((s) => ({ settings: { ...s.settings!, ...patch } }))
  })
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), defaultTuiAgent: 'claude' },
    updateSettings: update,
    refreshPreflightStatus: vi.fn(),
    checkLinearConnection: vi.fn()
  })
  refreshAgents.mockRejectedValue(new Error('probe still unavailable'))
  await useAppStore.getState().ensureDetectedAgents()
  const onboardingChanged = vi.fn()
  Object.assign(window.api, {
    onboarding: {
      update: vi.fn(async (patch: Parameters<typeof window.api.onboarding.update>[0]) => ({
        ...getDefaultOnboardingState(),
        ...patch,
        checklist: { ...getDefaultOnboardingState().checklist, ...patch.checklist }
      }))
    }
  })
  const view = render(
    <TooltipProvider>
      <OnboardingFlow
        onboarding={getDefaultOnboardingState()}
        onOnboardingChange={onboardingChanged}
      />
    </TooltipProvider>
  )
  await act(async () => {})
  expect(view.queryByText(/isn't on your PATH|No agents detected/)).toBeNull()
  fireEvent.click(view.getByRole('button', { name: /^Codex/ }))
  await act(async () => {
    fireEvent.click(view.getByRole('button', { name: /Continue/ }))
  })
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ defaultTuiAgent: 'codex' }))
  expect(onboardingChanged).toHaveBeenCalledWith(expect.objectContaining({ lastCompletedStep: 1 }))
  cleanup()
  const step = FEATURE_WALL_SETUP_STEPS.find((entry) => entry.id === 'default-agent')!
  const checklist = render(
    <TooltipProvider>
      <FeatureWallSetupChecklist
        activeStep={step}
        progress={{
          ready: true,
          coreDoneCount: 0,
          coreTotal: 8,
          stepDone: {
            'default-agent': false,
            'add-two-repos': false,
            notifications: false,
            'two-worktrees': false,
            browser: false,
            'task-sources': false,
            'agent-capabilities': false,
            'setup-script': false
          }
        }}
        onSelectStep={vi.fn()}
        onOrchestrationSkillInstalledChange={vi.fn()}
        onBrowserUseSkillInstalledChange={vi.fn()}
      />
    </TooltipProvider>
  )
  await act(async () => {})
  expect(checklist.queryByText(/isn't on your PATH|No agents detected/)).toBeNull()
  await act(async () => {
    fireEvent.click(checklist.getByRole('button', { name: /^Claude$/ }))
  })
  expect(useAppStore.getState().settings?.defaultTuiAgent).toBe('claude')
})

it('scopes the real catalog and AgentStep subscriptions while preserving full runtime repair details', async () => {
  const repo = { ...TEST_REPO, path: 'C:\\project' }
  const worktree = makeWorktree({ id: 'active', repoId: repo.id, path: repo.path })
  const catalog = projectHostSetupProjectionFromRepos([repo])
  const settings = getDefaultSettings('/tmp')
  useAppStore.setState({
    repos: [repo],
    activeRepoId: repo.id,
    activeWorktreeId: worktree.id,
    worktreesByRepo: { [repo.id]: [worktree] },
    settings,
    projects: catalog.projects.map((project) => ({
      ...project,
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })),
    projectHostSetups: [...catalog.setups]
  })
  const nativeContext = getLocalAgentPreflightContext(useAppStore.getState())
  expect(nativeContext).toEqual({
    projectRuntime: {
      status: 'resolved',
      runtime: {
        kind: 'windows-host',
        hostPlatform: 'win32',
        projectId: repo.id,
        reason: 'project-override',
        cacheKey: `${repo.id}:windows-host`
      }
    }
  })
  expect(localAgentInventoryContextKey(nativeContext)).toBe('host')
  expect(localAgentInventoryContextKey(nativeContext, true)).toBe('host\u0000all-agents')
  const enabledRequest = { ...nativeContext, enabledOnly: true }
  await useAppStore.getState().ensureDetectedAgents()
  expect(detectAgents).toHaveBeenCalledExactlyOnceWith(enabledRequest)
  expect(useAppStore.getState().readLocalAgentInventoryByKey('host')).toEqual({
    ids: null,
    state: 'failed'
  })
  expect(useAppStore.getState().isDetectingLocalAgentsByContext.host).toBeUndefined()
  const resolution = vi.spyOn(runtime, 'resolveProjectExecutionRuntime')
  const commits = { catalog: 0, step: 0 }
  const view = render(
    <TooltipProvider>
      <Profiler id="catalog" onRender={() => (commits.catalog += 1)}>
        <AgentLaunchSettingsCatalog
          settings={projectAgentLaunchSettings(settings)}
          mutate={vi.fn<ComponentProps<typeof AgentLaunchSettingsCatalog>['mutate']>(
            async () => {}
          )}
          detectionTarget={{ kind: 'local' }}
          hostName={null}
          renderPermissions={() => null}
        />
      </Profiler>
      <Profiler id="step" onRender={() => (commits.step += 1)}>
        <AgentStep
          selectedAgent="claude"
          onSelect={vi.fn()}
          detectedSet={new Set()}
          isDetecting={false}
        />
      </Profiler>
    </TooltipProvider>
  )
  const selected = renderHook(() => useLocalAgentPreflightContext())
  await act(async () => {})
  expect(detectAgents).toHaveBeenCalledTimes(2)
  expect(detectAgents).toHaveBeenNthCalledWith(2, nativeContext)
  expect(useAppStore.getState().readLocalAgentInventoryByKey('host\u0000all-agents')).toEqual({
    ids: null,
    state: 'failed'
  })
  expect(
    useAppStore.getState().isDetectingLocalAgentsByContext['host\u0000all-agents']
  ).toBeUndefined()
  expect(view.queryByText(/isn't on your PATH|No agents detected/)).toBeNull()
  expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy()
  commits.catalog = commits.step = 0
  resolution.mockClear()
  const selectedFailure = () => {
    const state = useAppStore.getState()
    return ['host', 'host\u0000all-agents'].map((key) => ({
      key,
      failed: state.localAgentInventoryFailedByContext[key],
      outcome: state.readLocalAgentInventoryByKey(key)
    }))
  }
  const beforeFailure = selectedFailure()
  expect(beforeFailure.every(({ failed }) => failed === true)).toBe(true)
  const publications: ((state: AppState) => Partial<AppState>)[] = [
    () => ({ isDetectingAgents: false }),
    () => ({ detectedWorktreesByRepo: { otherHost: makeDetectedResult('otherHost', []) } }),
    () => ({ remoteDetectedAgentIds: { otherHost: ['codex'] } }),
    (state) => ({
      localAgentInventoryFailedByContext: {
        ...state.localAgentInventoryFailedByContext,
        anotherContext: true
      }
    })
  ]
  for (const patch of publications) {
    await act(async () => {
      useAppStore.setState(patch)
    })
    expect(selectedFailure()).toEqual(beforeFailure)
    expect(commits).toEqual({ catalog: 0, step: 0 })
    expect(resolution).not.toHaveBeenCalled()
    expect(detectAgents).toHaveBeenCalledTimes(2)
  }
  await act(async () => {
    useAppStore.setState({ isRefreshingLocalAgentsByContext: { host: true } })
  })
  expect(commits.step).toBeGreaterThan(0)
  expect(detectAgents).toHaveBeenCalledTimes(2)
  expect(view.getByText(/isn't on your PATH/)).toBeTruthy()
  await act(async () => {
    useAppStore.setState({ isRefreshingLocalAgentsByContext: {} })
  })
  expect(view.queryByText(/isn't on your PATH/)).toBeNull()
  expect(detectAgents).toHaveBeenCalledTimes(2)
  const before = selected.result.current
  expect(before?.projectRuntime).toMatchObject({ runtime: { reason: 'project-override' } })
  await act(async () => {
    useAppStore.setState((s) => ({
      projects: s.projects.map((project) => ({
        ...project,
        localWindowsRuntimePreference: { kind: 'inherit-global' }
      }))
    }))
  })
  expect(localAgentInventoryContextKey(selected.result.current)).toBe('host')
  expect(selected.result.current).not.toBe(before)
  expect(selected.result.current?.projectRuntime).toMatchObject({
    runtime: { projectId: repo.id, reason: 'global-default' }
  })
  expect(selected.result.current).toEqual({
    projectRuntime: {
      status: 'resolved',
      runtime: {
        kind: 'windows-host',
        hostPlatform: 'win32',
        projectId: repo.id,
        reason: 'global-default',
        cacheKey: `${repo.id}:windows-host`
      }
    }
  })
  expect(localAgentInventoryContextKey(selected.result.current, true)).toBe('host\u0000all-agents')
  expect(selectedFailure()).toEqual(beforeFailure)
  expect(detectAgents).toHaveBeenCalledTimes(2)
  await act(async () => {
    useAppStore.setState((s) => ({
      settings: {
        ...(s.settings ?? settings),
        localWindowsRuntimeDefault: { kind: 'wsl', distro: null }
      }
    }))
  })
  expect(selected.result.current?.projectRuntime).toMatchObject({
    status: 'repair-required',
    repair: { source: 'global-default', reason: 'wsl-distro-required' }
  })
  const repairContext = selected.result.current
  const repairKey = `${repo.id}:repair:wsl-distro-required:default\u0000all-agents`
  expect(repairContext).toEqual({
    projectRuntime: {
      status: 'repair-required',
      repair: {
        projectId: repo.id,
        preferredRuntime: { kind: 'wsl', distro: null },
        source: 'global-default',
        reason: 'wsl-distro-required',
        cacheKey: `${repo.id}:repair:wsl-distro-required:default`
      }
    }
  })
  expect(localAgentInventoryContextKey(repairContext, true)).toBe(repairKey)
  expect(detectAgents).toHaveBeenCalledTimes(3)
  expect(detectAgents).toHaveBeenNthCalledWith(3, repairContext)
  expect(useAppStore.getState().readLocalAgentInventoryByKey(repairKey)).toEqual({
    ids: null,
    state: 'failed'
  })
  expect(useAppStore.getState().isDetectingLocalAgentsByContext[repairKey]).toBeUndefined()
  expect(selectedFailure()).toEqual(beforeFailure)
  expect(view.getByText(/Choose a WSL distro/)).toBeTruthy()
  expect(view.getByText(/Open project Settings → Project Runtime/)).toBeTruthy()
  expect(view.queryByText(/Try again/)).toBeNull()
  await act(async () => {
    useAppStore.setState((s) => ({
      settings: {
        ...(s.settings ?? settings),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      }
    }))
  })
  expect(view.queryByText(/Open project Settings → Project Runtime/)).toBeNull()
  expect(view.getByText(/Couldn't check which agents/)).toBeTruthy()
  expect(localAgentInventoryContextKey(selected.result.current, true)).toBe('host\u0000all-agents')
  expect(selectedFailure()).toEqual(beforeFailure)
  const expectedRequests = [[enabledRequest], [nativeContext], [repairContext]]
  expect(detectAgents.mock.calls).toEqual(expectedRequests)
  expect(detectAgents).toHaveBeenCalledTimes(expectedRequests.length)
  resolution.mockRestore()
})
