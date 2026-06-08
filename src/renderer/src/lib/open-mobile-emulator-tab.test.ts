import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { openMobileEmulatorTab } from './open-mobile-emulator-tab'
import {
  consumePrelaunchedSimulatorSession,
  isManualSimulatorLaunchPending
} from './simulator-launch-coordination'
import { ensureSimulatorTab, getSimulatorTabForWorktree } from './ensure-simulator-tab'

const mockStoreState = vi.hoisted(() => ({
  activeGroupIdByWorktree: { 'wt-1': 'group-1' } as Record<string, string>,
  groupsByWorktree: { 'wt-1': [{ id: 'group-1' }] } as Record<string, { id: string }[]>,
  settings: { mobileEmulatorEnabled: true } as { mobileEmulatorEnabled?: boolean }
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn()
  }
}))

vi.mock('./ensure-simulator-tab', () => ({
  ensureSimulatorTab: vi.fn(),
  getSimulatorTabForWorktree: vi.fn(),
  isMacOsHost: true
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
    mockStoreState.activeGroupIdByWorktree = { 'wt-1': 'group-1' }
    mockStoreState.groupsByWorktree = { 'wt-1': [{ id: 'group-1' }] }
    mockStoreState.settings = { mobileEmulatorEnabled: true }
    vi.mocked(callRuntimeRpc).mockReset()
    vi.mocked(ensureSimulatorTab).mockReset()
    vi.mocked(getSimulatorTabForWorktree).mockReset()
    vi.mocked(getSimulatorTabForWorktree).mockReturnValue(null)
    vi.mocked(toast.error).mockReset()
    consumePrelaunchedSimulatorSession('wt-1')
  })

  it('surfaces the simulator tab before attaching the emulator stream', async () => {
    const calls: string[] = []
    vi.mocked(callRuntimeRpc).mockImplementation(async () => {
      calls.push('attach')
      return mockAttachResult
    })
    vi.mocked(ensureSimulatorTab).mockImplementation(() => {
      calls.push('ensure')
      return 'sim-1'
    })

    await expect(openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })).resolves.toBe('sim-1')

    expect(calls).toEqual(['ensure', 'attach'])
    expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'emulator.attach', {
      worktree: 'wt-1',
      focus: false
    })
    expect(ensureSimulatorTab).toHaveBeenCalledWith('wt-1', {
      placement: 'rightSplit',
      targetGroupId: 'group-1',
      surfacePane: true
    })
    expect(consumePrelaunchedSimulatorSession('wt-1')).toEqual(mockAttachResult.info)
  })

  it('marks manual launch pending only while attach is in flight', async () => {
    let resolveAttach: (value: typeof mockAttachResult) => void = () => {}
    vi.mocked(callRuntimeRpc).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAttach = resolve
        })
    )
    vi.mocked(ensureSimulatorTab).mockReturnValue('sim-1')

    const launched = openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })

    expect(isManualSimulatorLaunchPending('wt-1')).toBe(true)
    resolveAttach(mockAttachResult)
    await launched

    expect(isManualSimulatorLaunchPending('wt-1')).toBe(false)
  })

  it('keeps the simulator tab open and reports an error when attach fails', async () => {
    vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('Xcode is not installed'))
    vi.mocked(ensureSimulatorTab).mockReturnValue('sim-1')

    await expect(openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })).resolves.toBe('sim-1')

    expect(ensureSimulatorTab).toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Xcode is not installed')
    expect(consumePrelaunchedSimulatorSession('wt-1')).toBeNull()
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
    vi.mocked(ensureSimulatorTab).mockReturnValue('sim-1')

    const firstLaunch = openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })
    await expect(openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })).resolves.toBe('sim-1')

    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    resolveAttach(mockAttachResult)
    await firstLaunch
  })

  it('does nothing when the workspace already has an emulator tab', async () => {
    vi.mocked(getSimulatorTabForWorktree).mockReturnValue({
      id: 'sim-existing',
      groupId: 'group-1',
      contentType: 'simulator'
    })

    await expect(openMobileEmulatorTab('wt-1', { targetGroupId: 'group-1' })).resolves.toBe(
      'sim-existing'
    )

    expect(ensureSimulatorTab).not.toHaveBeenCalled()
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(isManualSimulatorLaunchPending('wt-1')).toBe(false)
  })

  it('does not attach when the mobile emulator feature is disabled', async () => {
    mockStoreState.settings = { mobileEmulatorEnabled: false }

    await expect(openMobileEmulatorTab('wt-1')).resolves.toBeNull()

    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(ensureSimulatorTab).not.toHaveBeenCalled()
  })
})
