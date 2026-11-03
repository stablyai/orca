import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { EMULATOR_OPENING_PREFERENCES_CAPABILITY } from '../../../shared/emulator-runtime-capabilities'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { openMobileEmulatorTab } from './open-mobile-emulator-tab'
import {
  consumePrelaunchedSimulatorSession,
  isManualSimulatorLaunchPending,
  resetSimulatorLaunchCoordinationForTests
} from './simulator-launch-coordination'
import { cancelPendingSimulatorPaneShutdown } from './simulator-pane-shutdown-scheduler'
import { ensureSimulatorTab, getSimulatorTabForWorktree } from './ensure-simulator-tab'

const mockStoreState = vi.hoisted(() => ({
  activeGroupIdByWorktree: { 'wt-1': 'group-1' } as Record<string, string>,
  groupsByWorktree: { 'wt-1': [{ id: 'group-1' }] } as Record<string, { id: string }[]>,
  unifiedTabsByWorktree: {} as Record<string, { id: string; contentType: string }[]>,
  settings: { mobileEmulatorEnabled: true } as {
    mobileEmulatorEnabled?: boolean
    activeRuntimeEnvironmentId?: string | null
  },
  runtimeStatusByEnvironmentId: new Map()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

vi.mock('./ensure-simulator-tab', () => ({
  ensureSimulatorTab: vi.fn(),
  getSimulatorTabForWorktree: vi.fn()
}))

const mockAttachResult = {
  attached: true,
  info: {
    deviceUdid: 'device-1',
    streamUrl: 'http://127.0.0.1:3100/stream.mjpeg',
    wsUrl: 'ws://127.0.0.1:3100/ws'
  }
}

describe('openMobileEmulatorTab', () => {
  beforeEach(() => {
    setLocalRuntimeCapabilitiesForTests([])
    mockStoreState.activeGroupIdByWorktree = { 'wt-1': 'group-1' }
    mockStoreState.groupsByWorktree = { 'wt-1': [{ id: 'group-1' }] }
    mockStoreState.unifiedTabsByWorktree = {}
    mockStoreState.settings = { mobileEmulatorEnabled: true }
    vi.mocked(callRuntimeRpc).mockReset()
    vi.mocked(ensureSimulatorTab).mockReset()
    vi.mocked(ensureSimulatorTab).mockImplementation((worktreeId) => {
      mockStoreState.unifiedTabsByWorktree[worktreeId] = [{ id: 'sim-1', contentType: 'simulator' }]
      return 'sim-1'
    })
    vi.mocked(getSimulatorTabForWorktree).mockReset()
    vi.mocked(getSimulatorTabForWorktree).mockReturnValue(null)
    resetSimulatorLaunchCoordinationForTests()
  })

  afterEach(() => {
    cancelPendingSimulatorPaneShutdown('wt-1')
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('lets a capable pane resolve user preferences instead of prelaunching an arbitrary device', async () => {
    setLocalRuntimeCapabilitiesForTests([EMULATOR_OPENING_PREFERENCES_CAPABILITY])
    vi.mocked(ensureSimulatorTab).mockImplementationOnce(() => {
      expect(isManualSimulatorLaunchPending('wt-1')).toBe(false)
      return 'sim-1'
    })
    expect(await openMobileEmulatorTab('wt-1')).toBe('sim-1')
    expect(ensureSimulatorTab).toHaveBeenCalled()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(isManualSimulatorLaunchPending('wt-1')).toBe(false)
  })

  it('does not start a duplicate attach while a manual launch is already pending', async () => {
    let resolveAttach: (value: typeof mockAttachResult) => void = () => {}
    vi.mocked(callRuntimeRpc).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAttach = resolve
        })
    )

    const firstLaunch = openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })
    await expect(openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })).resolves.toBe('sim-1')

    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    resolveAttach(mockAttachResult)
    await firstLaunch
  })

  it('shuts down the managed emulator if the tab closes before attach resolves', async () => {
    let resolveAttach: (value: typeof mockAttachResult) => void = () => {}
    vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method) => {
      if (method === 'emulator.attach') {
        return new Promise((resolve) => {
          resolveAttach = resolve
        })
      }
      if (method === 'emulator.shutdown') {
        return { ok: true }
      }
      throw new Error(`Unexpected RPC method: ${method}`)
    })

    const launched = openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })
    mockStoreState.unifiedTabsByWorktree['wt-1'] = []
    resolveAttach(mockAttachResult)

    await expect(launched).resolves.toBe('sim-1')

    expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'emulator.shutdown', {
      worktree: 'wt-1',
      managedOnly: true
    })
    expect(consumePrelaunchedSimulatorSession('wt-1')).toBeNull()
  })

  it('allows a successful retry after simulator tab creation returns null', async () => {
    vi.mocked(ensureSimulatorTab).mockReturnValueOnce(null).mockReturnValueOnce('sim-retry')
    vi.mocked(callRuntimeRpc).mockResolvedValue(mockAttachResult)

    await expect(openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })).resolves.toBeNull()
    await expect(openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })).resolves.toBe(
      'sim-retry'
    )

    expect(ensureSimulatorTab).toHaveBeenCalledTimes(2)
    const attachCalls = vi
      .mocked(callRuntimeRpc)
      .mock.calls.filter(([, method]) => method === 'emulator.attach')
    expect(attachCalls).toHaveLength(1)
    expect(isManualSimulatorLaunchPending('wt-1')).toBe(false)
  })

  it('does not release another in-flight launch when duplicate tab creation throws', async () => {
    let resolveAttach: (value: typeof mockAttachResult) => void = () => {}
    vi.mocked(callRuntimeRpc).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAttach = resolve
        })
    )
    vi.mocked(ensureSimulatorTab)
      .mockImplementationOnce(() => {
        mockStoreState.unifiedTabsByWorktree['wt-1'] = [
          {
            id: 'sim-1',
            contentType: 'simulator'
          }
        ]
        return 'sim-1'
      })
      .mockImplementationOnce(() => {
        throw new Error('split group missing')
      })

    const firstLaunch = openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })
    await expect(openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })).rejects.toThrow(
      'split group missing'
    )

    expect(isManualSimulatorLaunchPending('wt-1')).toBe(true)
    resolveAttach(mockAttachResult)
    await firstLaunch
    expect(isManualSimulatorLaunchPending('wt-1')).toBe(false)
  })
})
