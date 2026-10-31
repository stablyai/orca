// @vitest-environment happy-dom
import {
  rpc,
  server,
  raw,
  payloadWork,
  compositions,
  payload,
  status
} from './new-tab-agent-menu-host-preferences-test-fixture'
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { getDefaultSettings } from '../../../../shared/constants'
import { expectSettingsWorkScale } from '../../../../shared/global-settings-test-fixture'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import {
  makeFolderWorkspace,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { mutateHostAgentLaunchSettings } from '../settings/agent-launch-settings-transport'
import {
  ensureAgentLaunchPreferences,
  readAgentLaunchPreferencesForWorktree,
  readAgentLaunchPreferencesForWorkspace
} from '../settings/use-host-agent-launch-preferences'
import { useAgentLaunchPickerInventory } from '../agent/use-agent-launch-picker-inventory'
import { agentMenuShortcutLabels } from './agent-menu-shortcut-labels'
import { useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'

it.each(['wt', 'folder:f1'])(
  'uses the host list and default for %s without changing desktop settings',
  async (id) => {
    const hook = renderHook(() =>
      useNewTabAgentMenuRows(id, true, { kind: 'runtime', environmentId: 'alpha' })
    )
    expect(hook.result.current.state).toBe('loading')
    await act(async () => {})
    expect(hook.result.current.state === 'settled' && hook.result.current.rows).toEqual([
      { kind: 'cli', agent: 'codex', chat: true, executionHostId: 'runtime:alpha' },
      { kind: 'cli', agent: 'claude', chat: true, executionHostId: 'runtime:alpha' }
    ])
    expect(rpc.call.mock.calls[0]?.[0]).toEqual({ kind: 'environment', environmentId: 'alpha' })
    expect(rpc.call.mock.calls[0]?.[3]).toMatchObject({
      expectedEnvironmentPairingRevision: 7,
      expectedEnvironmentRuntimeId: 'runtime-1'
    })
    expect(useAppStore.getState().settings?.disabledTuiAgents).toEqual(['codex'])
    expect([
      ...agentMenuShortcutLabels(
        id,
        {
          'tab.newAgent.codex': ['Mod+Shift+X'],
          'tab.newAgent.opencode': ['Mod+Shift+O']
        },
        'darwin'
      )
    ]).toEqual([['codex', '⌘⇧X']])
  }
)

it('filters chat and CLI rows with host preferences while keeping the desktop chat presentation', async () => {
  useAppStore.setState((state) => ({
    settings: {
      ...state.settings!,
      agentDefaultSurface: 'chat',
      nativeChatProviders: { claude: false }
    }
  }))
  const hook = renderHook(() =>
    useNewTabAgentMenuRows('folder:f1', true, { kind: 'runtime', environmentId: 'alpha' })
  )
  await act(async () => {})
  expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]).toEqual({
    kind: 'chat',
    agent: 'codex',
    executionHostId: 'runtime:alpha'
  })
  expect(
    hook.result.current.state === 'settled' &&
      hook.result.current.rows.some((row) => row.agent === 'opencode')
  ).toBe(false)
})

it('ignores old reads across host switches, restarts, and re-pairing', async () => {
  const old = Promise.withResolvers<{ settings: typeof server }>()
  rpc.call.mockReturnValueOnce(old.promise)
  const hook = renderHook(
    ({ environmentId }) =>
      useNewTabAgentMenuRows(
        { workspace: { kind: 'folder', runtimeEnvironmentId: environmentId } },
        true,
        { kind: 'runtime', environmentId }
      ),
    { initialProps: { environmentId: 'alpha' } }
  )
  await act(async () => {})
  hook.rerender({ environmentId: 'beta' })
  await act(async () => {})
  expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
    'codex'
  )
  await act(async () =>
    old.resolve({ settings: projectAgentLaunchSettings({ disabledTuiAgents: ['codex'] }) })
  )
  expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
    'codex'
  )
  const restarted = Promise.withResolvers<{ settings: typeof server }>()
  rpc.call.mockReturnValueOnce(restarted.promise)
  act(() =>
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([['beta', status('replacement')]])
    })
  )
  expect(hook.result.current.state).toBe('loading')
  await act(async () => {})
  replaceRuntimeEnvironmentRevisions([{ id: 'beta', createdAt: 9 }])
  act(() =>
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([['beta', status('replacement')]])
    })
  )
  await act(async () => {})
  expect(rpc.call.mock.calls.at(-1)?.[3]).toMatchObject({ expectedEnvironmentPairingRevision: 9 })
  await act(async () =>
    restarted.resolve({ settings: projectAgentLaunchSettings({ disabledTuiAgents: ['codex'] }) })
  )
  expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
    'codex'
  )
})

it.each([20, 200])('bounds %s menu owners across save/open', async (n) => {
  const reads = () => rpc.call.mock.calls.filter((call) => call[1] === 'settings.getAgentLaunch')
  const mutations = () =>
    rpc.call.mock.calls.filter((call) => call[1] === 'settings.mutateAgentLaunch')
  const notify = () =>
    mutateHostAgentLaunchSettings(
      { environmentId: 'alpha', pairingRevision: 7 },
      { type: 'availability', agent: 'opencode', enabled: false }
    )
  const old = Promise.withResolvers<void>()
  rpc.call.mockImplementationOnce(() => {
    const earlier = payload({ ...raw, disabledTuiAgents: ['codex'] })
    return old.promise.then(() => earlier)
  })
  const hooks = Array.from({ length: n }, () =>
    renderHook(
      ({ open }) => useNewTabAgentMenuRows('wt', open, { kind: 'runtime', environmentId: 'alpha' }),
      { initialProps: { open: true } }
    )
  )
  const hook = hooks[0]
  await act(async () => {})
  expect(reads()).toHaveLength(1)
  await act(notify)
  await act(async () => old.resolve())
  expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
    'codex'
  )
  expect(reads()).toHaveLength(2)
  hooks.forEach((h) => h.rerender({ open: false }))
  await act(notify)
  expect(reads()).toHaveLength(2)
  rpc.call.mockImplementation(() =>
    payload({ ...raw, defaultTuiAgent: 'claude', disabledTuiAgents: ['codex'] })
  )
  hooks.forEach((h) => h.rerender({ open: true }))
  await act(async () => {})
  expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
    'claude'
  )
  expect(reads()).toHaveLength(3)
  hooks.forEach((h) => h.unmount())
  await act(notify)
  expect(reads()).toHaveLength(3)
  expect(mutations()).toHaveLength(3)
  expect(rpc.call).toHaveBeenCalledTimes(6)
  expect(payloadWork.count).toBe(6)
  expectSettingsWorkScale('menu', n, [payloadWork.entries, payloadWork.bytes])
})

it('keeps this runtime’s last preferences through a failed reconnect refresh', async () => {
  const hook = renderHook(() =>
    useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
  )
  await act(async () => {})
  rpc.call.mockRejectedValueOnce(new Error('offline'))
  act(() =>
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([['alpha', { ...status(), hostContactEpoch: 2 }]])
    })
  )
  await act(async () => {})
  expect(rpc.call).toHaveBeenCalledTimes(2)
  expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
    'codex'
  )
})

it('reopens a freshly mounted menu with the last host answer, then revalidates', async () => {
  const first = renderHook(() =>
    useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
  )
  await act(async () => {})
  first.unmount()
  const pending = Promise.withResolvers<{ settings: typeof server }>()
  rpc.call.mockReturnValueOnce(pending.promise)
  const second = renderHook(() =>
    useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
  )
  expect(second.result.current.state === 'settled' && second.result.current.rows[0]?.agent).toBe(
    'codex'
  )
  await act(async () =>
    pending.resolve({ settings: projectAgentLaunchSettings({ defaultTuiAgent: 'claude' }) })
  )
  expect(second.result.current.state === 'settled' && second.result.current.rows[0]?.agent).toBe(
    'claude'
  )
})

it('keeps desktop preferences for a host that predates host launch settings', async () => {
  rpc.supports.mockResolvedValue(false)
  const hook = renderHook(() =>
    useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
  )
  await act(async () => {})
  expect(
    hook.result.current.state === 'settled' && hook.result.current.rows.map((row) => row.agent)
  ).toEqual(['opencode', 'claude'])
  expect(rpc.call).not.toHaveBeenCalled()
})

it('falls back to desktop preferences when the first read fails', async () => {
  rpc.call.mockRejectedValue(new Error('offline'))
  const hook = renderHook(() =>
    useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
  )
  await act(async () => {})
  expect(
    hook.result.current.state === 'settled' && hook.result.current.rows.map((row) => row.agent)
  ).toEqual(['opencode', 'claude'])
})

it('stops waiting on a stalled host, then applies its late answer', async () => {
  vi.useFakeTimers()
  try {
    const stalled = Promise.withResolvers<{ settings: typeof server }>()
    rpc.call.mockReturnValueOnce(stalled.promise)
    const hook = renderHook(() =>
      useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
    )
    expect(hook.result.current.state).toBe('loading')
    await act(async () => vi.advanceTimersByTime(3_000))
    expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
      'opencode'
    )
    await act(async () => stalled.resolve({ settings: server }))
    expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
      'codex'
    )
  } finally {
    vi.useRealTimers()
  }
})

it('gives the new-agent shortcut and badge the default the host menu applied', async () => {
  expect(readAgentLaunchPreferencesForWorktree(useAppStore.getState(), 'wt')).toEqual({
    defaultTuiAgent: 'opencode',
    disabledTuiAgents: ['codex'],
    agentLaunchChoices: {}
  })
  const hook = renderHook(() =>
    useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
  )
  await act(async () => {})
  expect(hook.result.current.state === 'settled' && hook.result.current.defaultTuiAgent).toBe(
    'codex'
  )
  expect(readAgentLaunchPreferencesForWorktree(useAppStore.getState(), 'wt')).toEqual({
    defaultTuiAgent: 'codex',
    disabledTuiAgents: ['opencode'],
    agentLaunchChoices: server.agentChoices?.defaults
  })
})

it('shares cold reads with independent cancelled waiters and retains mutation answers on failure', async () => {
  vi.useFakeTimers()
  try {
    const pending = Promise.withResolvers<{ settings: typeof server }>()
    rpc.call.mockReturnValueOnce(pending.promise)
    const menu = renderHook(() =>
      useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
    )
    const controller = new AbortController()
    const attempt = ensureAgentLaunchPreferences(
      useAppStore.getState(),
      { kind: 'git-worktree', worktreeId: 'wt' },
      controller.signal
    )
    const cancelled = expect(attempt).rejects.toMatchObject({ name: 'AbortError' })
    await act(async () => controller.abort())
    await cancelled
    expect(rpc.call).toHaveBeenCalledTimes(1)
    expect(rpc.call.mock.calls[0]?.[3].signal.aborted).toBe(false)
    await act(async () => pending.resolve({ settings: server }))
    rpc.call
      .mockResolvedValueOnce({ settings: server })
      .mockRejectedValueOnce(new Error('refresh failed'))
    await act(async () => {
      await mutateHostAgentLaunchSettings(
        { environmentId: 'alpha', pairingRevision: 7 },
        { type: 'availability', agent: 'claude', enabled: false }
      )
    })
    expect(menu.result.current).toMatchObject({ state: 'settled', defaultTuiAgent: 'codex' })
    await expect(
      ensureAgentLaunchPreferences(useAppStore.getState(), {
        kind: 'git-worktree',
        worktreeId: 'wt'
      })
    ).resolves.toMatchObject({ defaultTuiAgent: 'codex' })
    expect(rpc.call).toHaveBeenCalledTimes(3)
    const late = Promise.withResolvers<{ settings: typeof server }>()
    rpc.call.mockReturnValueOnce(late.promise)
    act(() =>
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([['alpha', { ...status(), hostContactEpoch: 3 }]])
      })
    )
    await act(async () => {})
    const signal = rpc.call.mock.calls.at(-1)?.[3].signal
    menu.unmount()
    await act(async () => {})
    expect(signal.aborted).toBe(true)
    await act(async () =>
      late.resolve({ settings: projectAgentLaunchSettings({ defaultTuiAgent: 'claude' }) })
    )
    expect(
      readAgentLaunchPreferencesForWorktree(useAppStore.getState(), 'wt').defaultTuiAgent
    ).toBe('codex')
  } finally {
    vi.useRealTimers()
  }
})
it.each(['pairing', 'runtime'] as const)(
  'cancels a cold event-only wait on actual %s retirement without another acquisition',
  async (change) => {
    vi.useFakeTimers()
    try {
      const pending = Promise.withResolvers<{ settings: typeof server }>()
      rpc.call.mockReturnValueOnce(pending.promise)
      const attempt = ensureAgentLaunchPreferences(useAppStore.getState(), {
        kind: 'git-worktree',
        worktreeId: 'wt'
      })
      const cancelled = expect(attempt).rejects.toMatchObject({ name: 'AbortError' })
      await act(async () => {})
      if (change === 'pairing') {
        replaceRuntimeEnvironmentRevisions([{ id: 'alpha', createdAt: 8 }])
      } else {
        useAppStore.setState({
          runtimeStatusByEnvironmentId: new Map([['alpha', status('replacement')]])
        })
      }
      await act(async () => vi.advanceTimersByTime(3_000))
      await cancelled
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([['alpha', status('replacement')]])
      })
      await act(async () => pending.resolve({ settings: server }))
      expect(
        readAgentLaunchPreferencesForWorktree(useAppStore.getState(), 'wt').agentLaunchChoices
      ).toEqual({})
      expect(rpc.call).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  }
)

it('updates actual inventory for native presentation and local permission changes', async () => {
  const hook = renderHook(() => {
    const menu = useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
    const entries = useAgentLaunchPickerInventory('wt', menu, true)
    return { menu, entries }
  })
  await act(async () => {})
  const before = hook.result.current.entries
  await act(async () => {
    useAppStore.setState((state) => ({
      settings: {
        ...state.settings!,
        nativeChatPermissionMode:
          state.settings?.nativeChatPermissionMode === 'ask' ? 'full-access' : 'ask'
      }
    }))
  })
  expect(hook.result.current.entries).not.toBe(before)
  expect(hook.result.current.menu.state).toBe('settled')
  useAppStore.setState({
    folderWorkspaces: [makeFolderWorkspace({ id: 'local', executionHostId: 'local' })]
  })
  const local = renderHook(() => {
    const menu = useNewTabAgentMenuRows('folder:local', true, { kind: 'local' })
    return useAgentLaunchPickerInventory('folder:local', menu, true)
  })
  await act(async () => {})
  await act(async () => {
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, agentPermissionDefault: 'ask' }
    }))
  })
  expect(
    local.result.current.find((entry) => entry.agent === 'claude')?.terminal.permissionMode
  ).toBe('ask')
})

it.each([30, 300])(
  'skips all fallback route/worktree work for a supplied context host across %i worktrees',
  async (count) => {
    const route = await import('@/lib/agent-launch-route-input')
    const builder = vi.spyOn(route, 'buildAgentLaunchRouteInput')
    let visited = 0
    const worktrees = Array.from({ length: count }, (_, i) => {
      const worktree = makeWorktree({
        id: `scale-${i}`,
        repoId: TEST_REPO.id,
        hostId: 'runtime:alpha'
      })
      Object.defineProperty(worktree, 'id', {
        get: () => {
          visited++
          return `scale-${i}`
        },
        enumerable: true
      })
      return worktree
    })
    useAppStore.setState({ worktreesByRepo: { [TEST_REPO.id]: worktrees } })
    visited = 0
    const id = `scale-${count - 1}`
    const model = {
      state: 'settled' as const,
      rows: [{ kind: 'terminal' as const, agent: 'claude' as const }],
      detection: {
        detectedIds: ['claude' as const],
        isLoading: false,
        isRefreshing: false,
        detectionFailed: false,
        needsServerUpdate: false,
        refresh: async () => ['claude' as const]
      },
      pickerContext: {
        workspace: { kind: 'git-worktree' as const, worktreeId: id },
        executionHostId: 'runtime:alpha',
        settings: null,
        key: `route-${count}`
      }
    }
    const hook = renderHook(
      ({ supplied, query }) => {
        void query
        return useAgentLaunchPickerInventory(
          id,
          supplied ? model : { ...model, pickerContext: undefined },
          false
        )
      },
      { initialProps: { supplied: true, query: '' } }
    )
    for (const query of ['c', 'cl', 'cla', 'claude']) {
      await act(async () => hook.rerender({ supplied: true, query }))
    }
    expect(builder).not.toHaveBeenCalled()
    expect(visited).toBe(0)
    await act(async () => hook.rerender({ supplied: false, query: 'fallback' }))
    expect(builder).toHaveBeenCalledOnce()
    expect(builder.mock.results[0].value.executionHostId).toBe('runtime:alpha')
    expect(visited).toBeGreaterThanOrEqual(count)
    builder.mockRestore()
  }
)

it.each([false, true])(
  'shares prospective, git and folder owner snapshots, including old hosts (%s)',
  async (supported) => {
    rpc.supports.mockResolvedValue(supported)
    const workspace = {
      kind: 'git-worktree',
      executionHostId: 'runtime:alpha',
      repoId: TEST_REPO.id
    } as const
    const read = () =>
      [
        readAgentLaunchPreferencesForWorkspace(useAppStore.getState(), workspace),
        readAgentLaunchPreferencesForWorkspace(useAppStore.getState(), {
          kind: 'folder',
          executionHostId: 'runtime:alpha'
        }),
        readAgentLaunchPreferencesForWorktree(useAppStore.getState(), 'wt'),
        readAgentLaunchPreferencesForWorktree(useAppStore.getState(), 'folder:f1')
      ].map((preferences) => preferences.defaultTuiAgent)
    expect(read()).toEqual(Array(4).fill('opencode'))
    expect(rpc.call).not.toHaveBeenCalled()
    await ensureAgentLaunchPreferences(useAppStore.getState(), workspace)
    expect(read()).toEqual(Array(4).fill(supported ? 'codex' : 'opencode'))
    if (supported) {
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([['alpha', status('replacement')]])
      })
      expect(read()).toEqual(Array(4).fill('opencode'))
      await ensureAgentLaunchPreferences(useAppStore.getState(), workspace)
      expect(read()).toEqual(Array(4).fill('codex'))
      replaceRuntimeEnvironmentRevisions([{ id: 'alpha', createdAt: 8 }])
      expect(read()).toEqual(Array(4).fill('opencode'))
    }
  }
)

it('keeps a cold detected shortcut synchronous without starting a preference read', async () => {
  const { resolveTerminalAgentTabShortcut } = await import('../terminal-agent-tab-shortcut')
  const { getRuntimeAgentInventoryKey } = await import('@/store/slices/runtime-agent-inventory-key')
  useAppStore.setState((state) => ({
    settings: { ...state.settings!, defaultTuiAgent: 'claude', disabledTuiAgents: [] },
    runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey('alpha', 'wt')]: ['claude', 'codex'] }
  }))
  expect(
    resolveTerminalAgentTabShortcut({
      activeWorktreeId: 'wt',
      keybindings: {},
      matchShortcut: (action) => action === 'tab.newAgent'
    })
  ).toEqual({ actionId: 'tab.newAgent', agent: 'claude' })
  expect(rpc.call).not.toHaveBeenCalled()
})

it('invalidates mounted picker seeds only for their effective authored-default source', async () => {
  useAppStore.setState((state) => ({
    settings: {
      ...state.settings!,
      disabledTuiAgents: [],
      agentLaunchChoices: { claude: { model: 'opus', options: { effort: 'high' } } }
    },
    folderWorkspaces: [makeFolderWorkspace({ id: 'local', executionHostId: 'local' })]
  }))
  let localRenders = 0
  let hostRenders = 0
  const local = renderHook(() => {
    const menu = useNewTabAgentMenuRows('folder:local', true, { kind: 'local' })
    localRenders++
    return useAgentLaunchPickerInventory('folder:local', menu, true)
  })
  const host = renderHook(() => {
    const menu = useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
    hostRenders++
    return useAgentLaunchPickerInventory('wt', menu, true)
  })
  await act(async () => {})
  const settled = { local: localRenders, host: hostRenders }
  const localSeed = () => local.result.current.find((entry) => entry.agent === 'claude')
  expect(localSeed()?.structured).toMatchObject({ model: 'opus', options: { effort: 'high' } })
  await act(async () => {
    useAppStore.setState((state) => ({ settings: { ...state.settings!, terminalFontSize: 19 } }))
  })
  expect({ local: localRenders, host: hostRenders }).toEqual(settled)
  await act(async () => {
    useAppStore.setState((state) => ({
      runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set(
        'beta',
        status('other-runtime')
      )
    }))
  })
  expect({ local: localRenders, host: hostRenders }).toEqual(settled)
  await act(async () => {
    useAppStore.setState((state) => ({
      settings: {
        ...state.settings!,
        agentLaunchChoices: {
          claude: { model: 'sonnet', options: { effort: 'low' } }
        }
      }
    }))
  })
  expect(localRenders).toBeGreaterThan(settled.local)
  expect(hostRenders).toBe(settled.host)
  expect(localSeed()?.terminal).toMatchObject({ model: 'sonnet', options: { effort: 'low' } })
  expect(localSeed()?.structured).toMatchObject({ model: 'sonnet', options: { effort: 'low' } })
  const beforeHostChange = localRenders
  rpc.call.mockImplementation(() => ({
    settings: projectAgentLaunchSettings({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['opencode'],
      agentLaunchChoices: { codex: { model: 'new-host-model', options: { effort: 'high' } } }
    })
  }))
  await act(async () => {
    await mutateHostAgentLaunchSettings(
      { environmentId: 'alpha', pairingRevision: 7 },
      { type: 'launch-choices', agent: 'codex', patch: { model: 'new-host-model' } }
    )
  })
  expect(hostRenders).toBeGreaterThan(settled.host)
  expect(localRenders).toBe(beforeHostChange)
  expect(host.result.current.find((entry) => entry.agent === 'codex')?.terminal).toMatchObject({
    model: 'new-host-model',
    options: { effort: 'high' }
  })
  const previousOwner = host.result.current[0]?.ownerKey
  await act(async () => {
    useAppStore.setState((state) => ({
      runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set(
        'alpha',
        status('replacement-runtime')
      )
    }))
  })
  expect(host.result.current[0]?.ownerKey).not.toBe(previousOwner)
  expect(localRenders).toBe(beforeHostChange)
})

it('reprojects a supplied local authored map once without host acquisition', async () => {
  const route = await import('@/lib/agent-launch-route-input')
  const builder = vi.spyOn(route, 'buildAgentLaunchRouteInput')
  const model = {
    state: 'settled' as const,
    rows: [{ kind: 'terminal' as const, agent: 'claude' as const }],
    detection: {
      detectedIds: ['claude' as const],
      isLoading: false,
      isRefreshing: false,
      detectionFailed: false,
      needsServerUpdate: false,
      refresh: async () => ['claude' as const]
    },
    pickerContext: {
      workspace: { kind: 'floating' as const },
      executionHostId: 'local',
      key: 'bounded-local',
      settings: {
        ...getDefaultSettings('/home/me'),
        agentLaunchChoices: { claude: { model: 'opus' } }
      }
    }
  }
  const profiles = vi.spyOn(
    await import('../../../../shared/agent-launch-profile'),
    'projectAgentLaunchProfile'
  )
  const before = compositions.mock.calls.length
  const profileBefore = profiles.mock.calls.length
  const hook = renderHook(
    ({ supplied }) => useAgentLaunchPickerInventory(undefined, supplied, false),
    { initialProps: { supplied: model } }
  )
  await act(async () => {})
  await act(async () =>
    hook.rerender({
      supplied: {
        ...model,
        pickerContext: {
          ...model.pickerContext,
          settings: {
            ...model.pickerContext.settings,
            agentLaunchChoices: { claude: { model: 'sonnet' } }
          }
        }
      }
    })
  )
  expect(hook.result.current[0]?.terminal.model).toBe('sonnet')
  expect(builder).not.toHaveBeenCalled()
  expect(compositions.mock.calls.length - before).toBe(0)
  expect(profiles.mock.calls.length - profileBefore).toBe(2)
  profiles.mockRestore()
  builder.mockRestore()
})
