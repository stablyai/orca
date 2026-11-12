// @vitest-environment happy-dom
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import * as terminalDiscovery from '@/runtime/terminal/terminal-model-discovery-client'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { resetRendererAppPlatformCacheForTests } from '@/app-shell/platform/renderer-app-platform'
import { detection, rpc, server, status } from './new-tab-agent-menu-host-preferences-test-fixture'
import { act, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'

import { projectAgentLaunchSettings } from '../../../../shared/agent-launch/choices/agent-launch-settings'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { mutateHostAgentLaunchSettings } from '../../runtime/agent-launch-settings/agent-launch-settings-transport'
import {
  ensureAgentLaunchPreferences,
  readAgentLaunchPreferencesForWorktree
} from '../../runtime/agent-launch-settings/use-host-agent-launch-preferences'
import {
  useAgentLaunchPickerInventorySource,
  useAgentPickerInventoryEntries
} from '../agent/use-agent-launch-picker-inventory'

import { useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'

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
      'claude'
    )
    await act(async () => stalled.resolve({ settings: server }))
    expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
      'codex'
    )
  } finally {
    vi.useRealTimers()
  }
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
    return useAgentPickerInventoryEntries(
      useAgentLaunchPickerInventorySource('folder:local', menu, true)
    )
  })
  const host = renderHook(() => {
    const menu = useNewTabAgentMenuRows('wt', true, { kind: 'runtime', environmentId: 'alpha' })
    hostRenders++
    return useAgentPickerInventoryEntries(useAgentLaunchPickerInventorySource('wt', menu, true))
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

it('refreshes equal-row terminal inventories for global and owning-project runtime changes', async () => {
  detection.ids = ['antigravity']
  const previous = Object.getOwnPropertyDescriptor(window, 'api')
  const old = Promise.withResolvers<unknown>()
  const read = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockImplementation(async () => ({
      success: true,
      catalogOrigin: 'probe',
      models: [{ id: 'new-runtime', label: 'New runtime' }]
    }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      platform: { get: () => ({ platform: 'win32' }) },
      git: { discoverTerminalModels: read }
    }
  })
  resetRendererAppPlatformCacheForTests()
  const id = 'repo1::C:/repo'
  useAppStore.setState((state) => ({
    settings: {
      ...state.settings!,
      disabledTuiAgents: [],
      agentDefaultSurface: 'terminal',
      localWindowsRuntimeDefault: { kind: 'windows-host' }
    },
    repos: [TEST_REPO],
    worktreesByRepo: {
      repo1: [makeWorktree({ id, path: 'C:/repo', repoId: 'repo1', hostId: 'local' })]
    },
    projects: [
      {
        id: 'project1',
        displayName: 'Project',
        badgeColor: 'blue',
        sourceRepoIds: ['repo1'],
        createdAt: 1,
        updatedAt: 1
      }
    ],
    detectedAgentIds: ['antigravity']
  }))
  const hook = renderHook(() => {
    const model = useNewTabAgentMenuRows(id, true, { kind: 'local' })
    return {
      model,
      entries: useAgentPickerInventoryEntries(useAgentLaunchPickerInventorySource(id, model, true))
    }
  })
  try {
    await waitFor(() => expect(read).toHaveBeenCalledOnce())
    const before = hook.result.current.model
    await act(async () =>
      useAppStore.setState((state) => ({
        settings: {
          ...state.settings!,
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        }
      }))
    )
    await waitFor(() =>
      expect(
        hook.result.current.entries.find((entry) => entry.agent === 'antigravity')?.terminalCatalog
      ).toMatchObject({
        models: [{ id: 'new-runtime' }]
      })
    )
    if (before.state !== 'settled' || hook.result.current.model.state !== 'settled') {
      throw new Error('Expected settled menu')
    }
    expect(hook.result.current.model.rows).toEqual(before.rows)
    await act(async () =>
      old.resolve({
        success: true,
        catalogOrigin: 'probe',
        models: [{ id: 'stale-host', label: 'Stale' }]
      })
    )
    expect(
      hook.result.current.entries.find((entry) => entry.agent === 'antigravity')?.terminalCatalog
    ).toMatchObject({ models: [{ id: 'new-runtime' }] })
    read.mockResolvedValue({
      success: true,
      catalogOrigin: 'probe',
      models: [{ id: 'project-runtime', label: 'Project runtime' }]
    })
    await act(async () =>
      useAppStore.setState((state) => ({
        projects: state.projects.map((project) => ({
          ...project,
          localWindowsRuntimePreference: { kind: 'windows-host' as const }
        }))
      }))
    )
    await waitFor(() =>
      expect(
        hook.result.current.entries.find((entry) => entry.agent === 'antigravity')?.terminalCatalog
      ).toMatchObject({ models: [{ id: 'project-runtime' }] })
    )
  } finally {
    hook.unmount()
    if (previous) {
      Object.defineProperty(window, 'api', previous)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
    resetRendererAppPlatformCacheForTests()
  }
})

it.each([3, 30])(
  'does no discovery work for %i closed menus or unrelated title and status changes',
  async (count) => {
    const ids = Array.from({ length: count + 1 }, (_, i) => `repo1::/repo/menu-${i}`)
    useAppStore.setState((state) => ({
      settings: { ...state.settings!, disabledTuiAgents: [], agentDefaultSurface: 'terminal' },
      worktreesByRepo: {
        repo1: ids.map((id) => makeWorktree({ id, repoId: 'repo1', hostId: 'local' }))
      },
      activeWorktreeId: null,
      agentStatusByPaneKey: {},
      runtimeEnvironments: ['alpha', 'beta'].map((id) =>
        publicRuntimeEnvironment({ id, createdAt: 7 })
      ),
      tabsByWorktree: { [ids[0]]: [makeTab({ id: 'menu-tab', worktreeId: ids[0] })] }
    }))
    // Measure steady-state publications after the real writer establishes contact identity.
    for (const environmentId of ['alpha', 'beta']) {
      useAppStore.getState().applyRuntimeHostStatusSnapshot({
        environmentId,
        pairingRevision: 7,
        sequence: 0,
        checkedAt: 0,
        verification: 'verified',
        transport: 'ready',
        status: status(environmentId === 'alpha' ? 'runtime-1' : 'runtime-2').status
      })
    }
    const derive = vi.spyOn(terminalDiscovery, 'terminalModelDiscoveryDescriptor')
    const renders = [...ids.map(() => 0), 0]
    const menus = ids.map((id, index) =>
      renderHook(() => {
        renders[index]++
        return useNewTabAgentMenuRows(id, index === count, { kind: 'local' })
      })
    )
    const remote = renderHook(() => {
      renders[count + 1]++
      return useNewTabAgentMenuRows('folder:f1', true, { kind: 'runtime', environmentId: 'alpha' })
    })
    try {
      await act(async () => {})
      expect(remote.result.current.state).toBe('settled')
      if (remote.result.current.state !== 'settled') {
        throw new Error('Expected settled remote menu')
      }
      expect(remote.result.current.pickerContext?.executionHostId).toBe('runtime:alpha')
      derive.mockClear()
      const settled = [...renders]
      for (let index = 0; index < 10; index++) {
        act(() =>
          useAppStore.setState({
            agentStatusByPaneKey: {
              unrelated: {
                paneKey: 'unrelated',
                stateHistory: [],
                state: 'working',
                prompt: '',
                updatedAt: index,
                stateStartedAt: 0
              }
            }
          })
        )
        act(() =>
          useAppStore.setState((state) => ({
            tabsByWorktree: {
              ...state.tabsByWorktree,
              [ids[0]]: [makeTab({ id: 'menu-tab', worktreeId: ids[0], title: `Reply ${index}` })]
            }
          }))
        )
      }
      for (let sequence = 1; sequence <= 10; sequence++) {
        for (const environmentId of ['beta', 'alpha']) {
          const before = useAppStore.getState().runtimeStatusByEnvironmentId
          act(() =>
            useAppStore.getState().applyRuntimeHostStatusSnapshot({
              environmentId,
              pairingRevision: 7,
              sequence,
              checkedAt: sequence,
              verification: 'verified',
              transport: 'ready',
              status: status(environmentId === 'alpha' ? 'runtime-1' : 'runtime-2').status
            })
          )
          expect(useAppStore.getState().runtimeStatusByEnvironmentId).not.toBe(before)
          expect(
            useAppStore.getState().runtimeStatusByEnvironmentId.get(environmentId)?.snapshot
              ?.sequence
          ).toBe(sequence)
        }
      }
      expect(derive).not.toHaveBeenCalled()
      expect(renders).toEqual(settled)
      const priorRemote = remote.result.current
      act(() =>
        useAppStore.getState().applyRuntimeHostStatusSnapshot({
          environmentId: 'alpha',
          pairingRevision: 7,
          sequence: 11,
          checkedAt: 11,
          verification: 'verified',
          transport: 'ready',
          status: status('replacement-runtime').status
        })
      )
      await act(async () => {})
      expect(derive).toHaveBeenCalledOnce()
      expect(renders.slice(0, count + 1)).toEqual(settled.slice(0, count + 1))
      const nextRemote = remote.result.current
      if (priorRemote.state !== 'settled' || nextRemote.state !== 'settled') {
        throw new Error('Expected settled remote menu')
      }
      expect(nextRemote.pickerContext?.key).not.toBe(priorRemote.pickerContext?.key)
      derive.mockClear()
      const before = menus[count].result.current
      act(() =>
        useAppStore.setState((state) => ({
          settings: {
            ...state.settings!,
            localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
          }
        }))
      )
      expect(derive).toHaveBeenCalledTimes(2)
      expect(derive.mock.calls[0][1].worktreeId).toBe(ids[count])
      expect(renders.slice(0, count)).toEqual(settled.slice(0, count))
      const after = menus[count].result.current
      if (before.state !== 'settled' || after.state !== 'settled') {
        throw new Error('Expected settled menu')
      }
      expect(after.pickerContext?.key).not.toBe(before.pickerContext?.key)
    } finally {
      remote.unmount()
      menus.forEach((menu) => menu.unmount())
      derive.mockRestore()
    }
  }
)
