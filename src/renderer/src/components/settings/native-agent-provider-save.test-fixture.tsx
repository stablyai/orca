import { act, fireEvent, render, within } from '@testing-library/react'
import { expect, vi, type Mock } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { localAgentInventoryContextKey } from '@/lib/local-preflight-context-key'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSettingsCatalog } from './AgentLaunchSettingsCatalog'

export async function exerciseNativeInventoryRetryWhileProviderSavePending(
  refreshAgents: Mock<Window['api']['preflight']['refreshAgents']>
): Promise<void> {
  let settings: GlobalSettings = {
    ...getDefaultSettings('/tmp'),
    experimentalNativeChat: true,
    localWindowsRuntimeDefault: { kind: 'windows-host' },
    nativeChatProviders: { claude: true, codex: false },
    disabledTuiAgents: ['grok']
  }
  const expectedContext = {
    projectRuntime: {
      status: 'resolved',
      runtime: {
        kind: 'windows-host',
        hostPlatform: 'win32',
        projectId: 'local-project',
        reason: 'global-default',
        cacheKey: 'local-project:windows-host'
      }
    }
  }
  const allKey = 'host\u0000all-agents'
  const owned: Promise<unknown>[] = []
  const writes: Promise<void>[] = []
  const save = Promise.withResolvers<void>()
  type RefreshResult = Awaited<ReturnType<Window['api']['preflight']['refreshAgents']>>
  const failedReply = Promise.withResolvers<RefreshResult>()
  const successfulReply = Promise.withResolvers<RefreshResult>()
  const success: RefreshResult = {
    agents: ['claude', 'codex', 'grok'],
    addedPathSegments: [],
    shellHydrationOk: true,
    pathSource: 'shell_hydrate',
    pathFailureReason: 'none'
  }
  const originalEnsure = useAppStore.getState().ensureAllDetectedAgents
  const originalRefresh = useAppStore.getState().refreshAllDetectedAgents
  const ensureAll: AppState['ensureAllDetectedAgents'] = (...args) => {
    const pending = originalEnsure(...args)
    owned.push(pending)
    return pending
  }
  const refreshAll: AppState['refreshAllDetectedAgents'] = (...args) => {
    const pending = originalRefresh(...args)
    owned.push(pending)
    return pending
  }
  const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
    const pending = save.promise.then(() => {
      settings = { ...settings, ...updates }
      useAppStore.setState({ settings })
    })
    writes.push(pending)
    return pending
  })
  useAppStore.setState({
    settings,
    ensureAllDetectedAgents: ensureAll,
    refreshAllDetectedAgents: refreshAll
  })
  const element = () => (
    <AgentLaunchSettingsCatalog
      settings={projectAgentLaunchSettings(settings)}
      mutate={vi.fn(async () => {})}
      detectionTarget={{ kind: 'local' }}
      hostName={null}
      renderPermissions={() => null}
      local={{ settings, updateSettings, saveEnvironment: vi.fn(async () => {}) }}
    />
  )
  const detectAgents = vi.mocked(window.api.preflight.detectAgents)
  let view: ReturnType<typeof render> | undefined
  let scheduled = 0
  try {
    const context = getLocalAgentPreflightContext(useAppStore.getState())
    expect(context).toEqual(expectedContext)
    expect(localAgentInventoryContextKey(context)).toBe('host')
    expect(localAgentInventoryContextKey(context, true)).toBe(allKey)
    const native = useAppStore.getState().ensureNativeDetectedAgents()
    owned.push(native)
    await native
    view = render(element(), { wrapper: TooltipProvider })
    await act(async () => {
      await Promise.allSettled(owned)
    })
    expect(detectAgents.mock.calls).toEqual([[{ enabledOnly: true }], [expectedContext]])
    expect(useAppStore.getState().readLocalAgentInventoryByKey('host')).toEqual({
      ids: null,
      state: 'failed'
    })
    expect(useAppStore.getState().readLocalAgentInventoryByKey(allKey)).toEqual({
      ids: null,
      state: 'failed'
    })
    const claude = within(view.getByRole('radiogroup', { name: 'Open Claude as' }))
    const codex = within(view.getByRole('radiogroup', { name: 'Open Codex as' }))
    expect(claude.getByRole('radio', { name: 'Chat' }).getAttribute('aria-checked')).toBe('true')
    expect(codex.getByRole('radio', { name: 'CLI' }).getAttribute('aria-checked')).toBe('true')
    expect(claude.getByRole('radio', { name: 'CLI' }).getAttribute('aria-disabled')).not.toBe(
      'true'
    )
    expect(codex.getByRole('radio', { name: 'Chat' }).getAttribute('aria-disabled')).not.toBe(
      'true'
    )
    expect(updateSettings).not.toHaveBeenCalled()
    scheduled++
    fireEvent.click(claude.getByRole('radio', { name: 'CLI' }))
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledOnce())
    expect(settings.nativeChatProviders).toEqual({ claude: true, codex: false })
    expect(useAppStore.getState().settings?.nativeChatProviders).toEqual({
      claude: true,
      codex: false
    })
    refreshAgents.mockImplementationOnce(() => failedReply.promise)
    const selectedFailure = view.getByText(
      "Couldn't check which agents are installed on this computer. Try again."
    )
    await act(async () => {
      fireEvent.click(within(selectedFailure.parentElement!).getByRole('button', { name: 'Retry' }))
    })
    expect(refreshAgents.mock.calls).toEqual([[{ ...expectedContext, wakeWslDistro: true }]])
    for (const key of ['host', allKey]) {
      expect(useAppStore.getState().isRefreshingLocalAgentsByContext[key]).toBe(true)
      expect(useAppStore.getState().readLocalAgentInventoryByKey(key)).toEqual({
        ids: null,
        state: 'pending'
      })
    }
    expect(
      view.queryAllByText(/Couldn't check which agents are installed on this computer/)
    ).toHaveLength(0)
    expect(view.queryAllByRole('button', { name: 'Retry' })).toHaveLength(0)
    expect(settings.nativeChatProviders).toEqual({ claude: true, codex: false })
    await act(async () => {
      failedReply.reject(new Error('all-mode retry unavailable'))
      await Promise.allSettled(owned)
    })
    for (const key of ['host', allKey]) {
      expect(useAppStore.getState().readLocalAgentInventoryByKey(key)).toEqual({
        ids: null,
        state: 'failed'
      })
      expect(useAppStore.getState().isRefreshingLocalAgentsByContext[key]).toBeUndefined()
      expect(useAppStore.getState().isDetectingLocalAgentsByContext[key]).toBeUndefined()
    }
    expect(detectAgents).toHaveBeenCalledTimes(2)
    expect(refreshAgents).toHaveBeenCalledOnce()
    expect({
      computerFailures: view.queryAllByText(
        /Couldn't check which agents are installed on this computer/
      ).length,
      retries: view.queryAllByRole('button', { name: 'Retry' }).length
    }).toEqual({ computerFailures: 1, retries: 1 })
    refreshAgents.mockImplementationOnce(() => successfulReply.promise)
    await act(async () => {
      fireEvent.click(view!.getByRole('button', { name: 'Retry' }))
    })
    for (const key of ['host', allKey]) {
      expect(useAppStore.getState().isRefreshingLocalAgentsByContext[key]).toBe(true)
      expect(useAppStore.getState().readLocalAgentInventoryByKey(key)).toEqual({
        ids: null,
        state: 'pending'
      })
    }
    expect(
      view.queryAllByText(/Couldn't check which agents are installed on this computer/)
    ).toHaveLength(0)
    expect(view.queryAllByRole('button', { name: 'Retry' })).toHaveLength(0)
    expect(settings.nativeChatProviders).toEqual({ claude: true, codex: false })
    expect(updateSettings).toHaveBeenCalledOnce()
    await act(async () => {
      successfulReply.resolve(success)
      await Promise.allSettled(owned)
    })
    expect(useAppStore.getState().readLocalAgentInventoryByKey(allKey)).toEqual({
      ids: ['claude', 'codex', 'grok'],
      state: 'successful'
    })
    expect(useAppStore.getState().readLocalAgentInventory(FLOATING_TERMINAL_WORKTREE_ID)).toEqual({
      ids: ['claude', 'codex'],
      state: 'successful'
    })
    for (const key of ['host', allKey]) {
      expect(useAppStore.getState().localAgentInventoryFailedByContext[key]).toBeUndefined()
      expect(useAppStore.getState().isRefreshingLocalAgentsByContext[key]).toBeUndefined()
    }
    expect(
      view.queryAllByText(/Couldn't check which agents are installed on this computer/)
    ).toHaveLength(0)
    expect(view.queryAllByRole('button', { name: 'Retry' })).toHaveLength(0)
    expect(detectAgents.mock.calls).toEqual([[{ enabledOnly: true }], [expectedContext]])
    expect(refreshAgents.mock.calls).toEqual([
      [{ ...expectedContext, wakeWslDistro: true }],
      [{ ...expectedContext, wakeWslDistro: true }]
    ])
    expect(settings.nativeChatProviders).toEqual({ claude: true, codex: false })
    await act(async () => {
      save.resolve()
      await Promise.allSettled(writes)
    })
    expect(settings.nativeChatProviders).toEqual({ claude: false, codex: false })
    expect(useAppStore.getState().settings?.nativeChatProviders).toEqual({
      claude: false,
      codex: false
    })
    view.rerender(element())
    for (const name of ['Claude', 'Codex']) {
      expect(
        within(view.getByRole('radiogroup', { name: `Open ${name} as` }))
          .getByRole('radio', { name: 'CLI' })
          .getAttribute('aria-checked')
      ).toBe('true')
    }
  } finally {
    try {
      view?.unmount()
    } finally {
      save.resolve()
      failedReply.resolve(success)
      successfulReply.resolve(success)
      try {
        await act(async () => {
          await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(scheduled))
          await Promise.allSettled([...owned, ...writes])
        })
      } finally {
        try {
          useAppStore.getState().clearLocalDetectedAgents()
        } finally {
          useAppStore.setState({
            ensureAllDetectedAgents: originalEnsure,
            refreshAllDetectedAgents: originalRefresh
          })
        }
      }
    }
  }
}

export async function exerciseQueuedNativeProviderSave(): Promise<void> {
  let latest: GlobalSettings = { ...getDefaultSettings('/tmp'), experimentalNativeChat: true }
  useAppStore.setState({ settings: latest, localDetectedAgentIdsByContext: { host: [] } })
  const save = Promise.withResolvers<void>()
  const owned: Promise<unknown>[] = []
  const writes: Promise<void>[] = []
  const originalEnsure = useAppStore.getState().ensureAllDetectedAgents
  const ensureAll: AppState['ensureAllDetectedAgents'] = (...args) => {
    const pending = originalEnsure(...args)
    owned.push(pending)
    return pending
  }
  useAppStore.setState({ ensureAllDetectedAgents: ensureAll })
  const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
    const pending = save.promise.then(() => {
      latest = { ...latest, ...updates }
      useAppStore.setState({ settings: latest })
    })
    writes.push(pending)
    return pending
  })
  const element = () => (
    <AgentLaunchSettingsCatalog
      settings={projectAgentLaunchSettings(latest)}
      mutate={vi.fn(async () => {})}
      detectionTarget={{ kind: 'local' }}
      hostName={null}
      renderPermissions={() => null}
      local={{ settings: latest, updateSettings, saveEnvironment: vi.fn(async () => {}) }}
    />
  )
  let scheduled = 0
  let view: ReturnType<typeof render> | undefined
  try {
    view = render(element(), { wrapper: TooltipProvider })
    await act(async () => {
      await Promise.allSettled(owned)
    })
    const claude = within(view.getByRole('radiogroup', { name: 'Open Claude as' })).getByRole(
      'radio',
      { name: 'CLI' }
    )
    const grok = within(view.getByRole('radiogroup', { name: 'Open Grok as' })).getByRole('radio', {
      name: 'Chat'
    })
    expect(grok.getAttribute('aria-checked')).toBe('true')
    expect(updateSettings).not.toHaveBeenCalled()
    expect(latest.nativeChatProviders).toBeUndefined()
    scheduled++
    fireEvent.click(claude)
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1))
    scheduled++
    fireEvent.click(grok)
    scheduled++
    fireEvent.click(claude)
    act(() => {
      useAppStore.setState({ localDetectedAgentIdsByContext: { host: ['grok'] } })
    })
    view.rerender(element())
    expect(grok.getAttribute('aria-checked')).toBe('true')
    expect(updateSettings).toHaveBeenCalledTimes(1)
    await act(async () => {
      save.resolve()
      await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(3))
      await Promise.allSettled(writes)
    })
    expect(latest.nativeChatProviders).toEqual({ claude: false, grok: true })
    expect(useAppStore.getState().settings?.nativeChatProviders).toEqual({
      claude: false,
      grok: true
    })
  } finally {
    view?.unmount()
    save.resolve()
    try {
      await act(async () => {
        await vi.waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(scheduled))
        await Promise.allSettled([...owned, ...writes])
      })
    } finally {
      useAppStore.getState().clearLocalDetectedAgents()
      useAppStore.setState({ ensureAllDetectedAgents: originalEnsure })
    }
  }
}
