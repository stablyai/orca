// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentHookInstallStatus } from '../../../shared/agent-hook-types'
import { getDefaultSettings } from '../../../shared/constants'
import { installed, liveConsumerState, workspaceId } from './agent-hook-refresh.test-fixture'
import {
  AGENT_HOOK_STATUS_REFRESH_INTERVAL_MS,
  useAgentHookInstallStatusRefresh
} from './use-agent-hook-install-status-refresh'

let readStatuses: ReturnType<typeof vi.fn>

function setVisibility(visibilityState: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function flushRefresh(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('useAgentHookInstallStatusRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    readStatuses = vi.fn().mockResolvedValue([installed])
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { agentHooks: { installStatuses: readStatuses } }
    })
    useAppStore.setState(liveConsumerState())
    setVisibility('visible')
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([
    ['no tabs', () => ({ tabsByWorktree: {} })],
    ['no live PTY', () => ({ ptyIdsByTabId: {} })],
    ['unhydrated settings', () => ({ settings: null })],
    [
      'disabled hooks',
      () => ({ settings: { ...getDefaultSettings('/home/user'), agentStatusHooksEnabled: false } })
    ],
    [
      'disabled agent',
      () => ({
        settings: { ...getDefaultSettings('/home/user'), disabledTuiAgents: ['claude' as const] }
      })
    ],
    [
      'unmanaged agent',
      () => ({
        tabsByWorktree: {
          [workspaceId]: useAppStore.getState().tabsByWorktree[workspaceId].map((tab) => ({
            ...tab,
            launchAgent: 'opencode' as const
          }))
        }
      })
    ],
    ['remote runtime', () => ({ ptyIdsByTabId: { 'tab-1': ['remote:runtime-1@@pty-1'] } })],
    [
      'SSH folder',
      () => ({
        folderWorkspaces: useAppStore.getState().folderWorkspaces.map((folder) => ({
          ...folder,
          connectionId: 'ssh-1'
        }))
      })
    ],
    [
      'WSL folder',
      () => ({
        folderWorkspaces: useAppStore.getState().folderWorkspaces.map((folder) => ({
          ...folder,
          folderPath: '\\\\wsl$\\Ubuntu\\home\\user\\project'
        }))
      })
    ]
  ])('does not read or schedule scans with only %s', async (_name, state) => {
    useAppStore.setState(state())
    renderHook(() => useAgentHookInstallStatusRefresh())
    await flushRefresh()
    window.dispatchEvent(new Event('focus'))
    setVisibility('hidden')
    setVisibility('visible')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_HOOK_STATUS_REFRESH_INTERVAL_MS * 2)
    })
    expect(readStatuses).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts on the first live consumer and stops after its PTY exits', async () => {
    useAppStore.setState({ ptyIdsByTabId: {} })
    renderHook(() => useAgentHookInstallStatusRefresh())
    await flushRefresh()
    expect(readStatuses).not.toHaveBeenCalled()

    act(() => useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } }))
    await flushRefresh()
    expect(readStatuses).toHaveBeenCalledTimes(1)
    act(() => useAppStore.setState({ ptyIdsByTabId: {} }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_HOOK_STATUS_REFRESH_INTERVAL_MS * 2)
    })
    expect(readStatuses).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for visibility when a consumer starts hidden', async () => {
    useAppStore.setState({ ptyIdsByTabId: {} })
    setVisibility('hidden')
    renderHook(() => useAgentHookInstallStatusRefresh())
    act(() => useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } }))
    await flushRefresh()
    expect(readStatuses).not.toHaveBeenCalled()

    setVisibility('visible')
    await flushRefresh()
    expect(readStatuses).toHaveBeenCalledTimes(1)
  })

  it('does not restart scans or subscriptions after unmount', async () => {
    const { unmount } = renderHook(() => useAgentHookInstallStatusRefresh())
    await flushRefresh()
    unmount()
    act(() => {
      useAppStore.setState({ ptyIdsByTabId: {} })
      useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-2'] } })
    })
    window.dispatchEvent(new Event('focus'))
    await flushRefresh()
    expect(readStatuses).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads on mount and serially schedules the next visible refresh', async () => {
    renderHook(() => useAgentHookInstallStatusRefresh())
    await flushRefresh()

    expect(readStatuses).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().agentHookInstallStateByTarget).toEqual({ claude: 'installed' })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_HOOK_STATUS_REFRESH_INTERVAL_MS)
    })
    expect(readStatuses).toHaveBeenCalledTimes(2)
  })

  it('does not poll while hidden and refreshes once when visible again', async () => {
    renderHook(() => useAgentHookInstallStatusRefresh())
    await flushRefresh()
    setVisibility('hidden')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_HOOK_STATUS_REFRESH_INTERVAL_MS * 2)
    })
    expect(readStatuses).toHaveBeenCalledTimes(1)

    setVisibility('visible')
    await flushRefresh()
    expect(readStatuses).toHaveBeenCalledTimes(2)
  })

  it('keeps the last snapshot when a refresh fails', async () => {
    useAppStore.getState().setAgentHookInstallStatuses([installed])
    readStatuses.mockRejectedValueOnce(new Error('read failed'))

    renderHook(() => useAgentHookInstallStatusRefresh())
    await flushRefresh()

    expect(useAppStore.getState().agentHookInstallStateByTarget).toEqual({ claude: 'installed' })
  })

  it('does not schedule another scan if its consumer exits during a read', async () => {
    let resolveRead: ((statuses: AgentHookInstallStatus[]) => void) | undefined
    readStatuses.mockReturnValueOnce(
      new Promise<AgentHookInstallStatus[]>((resolve) => {
        resolveRead = resolve
      })
    )
    renderHook(() => useAgentHookInstallStatusRefresh())
    act(() => useAppStore.setState({ ptyIdsByTabId: {} }))
    resolveRead?.([installed])
    await flushRefresh()
    expect(readStatuses).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not overlap a focus refresh with an in-flight read', async () => {
    let resolveRead: ((statuses: AgentHookInstallStatus[]) => void) | undefined
    readStatuses.mockReturnValueOnce(
      new Promise<AgentHookInstallStatus[]>((resolve) => {
        resolveRead = resolve
      })
    )
    renderHook(() => useAgentHookInstallStatusRefresh())

    window.dispatchEvent(new Event('focus'))
    act(() => {
      useAppStore.setState({ ptyIdsByTabId: {} })
      useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-2'] } })
    })
    expect(readStatuses).toHaveBeenCalledTimes(1)

    resolveRead?.([installed])
    await flushRefresh()
    expect(readStatuses).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_HOOK_STATUS_REFRESH_INTERVAL_MS)
    })
    expect(readStatuses).toHaveBeenCalledTimes(2)
  })
})
