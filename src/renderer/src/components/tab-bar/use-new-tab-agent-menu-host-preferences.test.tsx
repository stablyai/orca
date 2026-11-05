// @vitest-environment happy-dom
import { rpc, server, status } from './new-tab-agent-menu-host-preferences-test-fixture'
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'

import { projectAgentLaunchSettings } from '../../../../shared/agent-launch/choices/agent-launch-settings'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
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
