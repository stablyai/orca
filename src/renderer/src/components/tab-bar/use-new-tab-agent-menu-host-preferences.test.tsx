// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import type { RuntimeEnvironmentStatus } from '../../../../shared/runtime-host-status'
import {
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT
} from '../../../../shared/protocol-version'
import {
  makeFolderWorkspace,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/worktrees-slice-test-fixtures'
import { mutateHostAgentLaunchSettings } from '../settings/agent-launch-settings-transport'
import {
  clearHostAgentMenuSettingsForTests,
  readAgentLaunchPreferencesForWorktree
} from '../settings/use-host-agent-launch-preferences'
import { useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'

const rpc = vi.hoisted(() => ({ call: vi.fn(), supports: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.call,
  runtimeEnvironmentSupportsCapability: rpc.supports
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({ detectedIds: ['claude', 'codex', 'opencode'] })
}))
const initial = useAppStore.getState()
const server = projectAgentLaunchSettings({
  defaultTuiAgent: 'codex',
  disabledTuiAgents: ['opencode']
})
function status(runtimeId = 'runtime-1'): RuntimeEnvironmentStatus {
  return {
    status: {
      runtimeId,
      capabilities: [CHAT, CLIENT],
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    },
    checkedAt: 1
  }
}
beforeEach(() => {
  rpc.call.mockReset().mockResolvedValue({ settings: server })
  rpc.supports.mockReset().mockResolvedValue(true)
  replaceRuntimeEnvironmentRevisions([{ id: 'alpha', createdAt: 7 }])
  setLocalRuntimeCapabilitiesForTests([CHAT, CLIENT])
  useAppStore.setState({
    ...initial,
    settings: {
      ...getDefaultSettings('/home/me'),
      defaultTuiAgent: 'opencode',
      disabledTuiAgents: ['codex'],
      experimentalNativeChat: false
    },
    runtimeStatusByEnvironmentId: new Map([
      ['alpha', status()],
      ['beta', status('runtime-2')]
    ]),
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: 'wt', repoId: TEST_REPO.id, hostId: 'runtime:alpha' })]
    },
    folderWorkspaces: [makeFolderWorkspace({ id: 'f1', executionHostId: 'runtime:alpha' })]
  })
})
afterEach(() => {
  cleanup()
  clearHostAgentMenuSettingsForTests()
  useAppStore.setState(initial, true)
  setLocalRuntimeCapabilitiesForTests(null)
  replaceRuntimeEnvironmentRevisions([])
})

it.each(['wt', 'folder:f1'])(
  'uses the host list and default for %s without changing desktop settings',
  async (id) => {
    const hook = renderHook(() =>
      useNewTabAgentMenuRows(id, true, { kind: 'runtime', environmentId: 'alpha' })
    )
    expect(hook.result.current.state).toBe('loading')
    await act(async () => {})
    expect(hook.result.current.state === 'settled' && hook.result.current.rows).toEqual([
      { kind: 'terminal', agent: 'codex', executionHostId: 'runtime:alpha' },
      { kind: 'terminal', agent: 'claude', executionHostId: 'runtime:alpha' }
    ])
    expect(rpc.call.mock.calls[0]?.[0]).toEqual({ kind: 'environment', environmentId: 'alpha' })
    expect(rpc.call.mock.calls[0]?.[3]).toMatchObject({
      expectedEnvironmentPairingRevision: 7,
      expectedEnvironmentRuntimeId: 'runtime-1'
    })
    expect(useAppStore.getState().settings?.disabledTuiAgents).toEqual(['codex'])
  }
)

it('filters chat and CLI rows with host preferences while keeping the desktop chat presentation', async () => {
  useAppStore.setState((state) => ({
    settings: { ...state.settings!, experimentalNativeChat: true }
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

it('refreshes after a save, fences the earlier read, and refreshes on reopening', async () => {
  const old = Promise.withResolvers<{ settings: typeof server }>()
  rpc.call.mockReturnValueOnce(old.promise)
  const hook = renderHook(
    ({ open }) => useNewTabAgentMenuRows('wt', open, { kind: 'runtime', environmentId: 'alpha' }),
    { initialProps: { open: true } }
  )
  await act(async () => {})
  await act(async () => {
    await mutateHostAgentLaunchSettings(
      { environmentId: 'alpha', pairingRevision: 7 },
      { type: 'availability', agent: 'opencode', enabled: false }
    )
  })
  await act(async () =>
    old.resolve({ settings: projectAgentLaunchSettings({ disabledTuiAgents: ['codex'] }) })
  )
  expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
    'codex'
  )
  hook.rerender({ open: false })
  rpc.call.mockResolvedValue({
    settings: projectAgentLaunchSettings({
      defaultTuiAgent: 'claude',
      disabledTuiAgents: ['codex']
    })
  })
  hook.rerender({ open: true })
  await act(async () => {})
  expect(hook.result.current.state === 'settled' && hook.result.current.rows[0]?.agent).toBe(
    'claude'
  )
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
    disabledTuiAgents: ['codex']
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
    disabledTuiAgents: ['opencode']
  })
})
