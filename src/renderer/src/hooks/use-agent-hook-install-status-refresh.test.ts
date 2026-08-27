// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AgentHookInstallStatus } from '../../../shared/agent-hook-types'
import {
  AGENT_HOOK_STATUS_REFRESH_INTERVAL_MS,
  useAgentHookInstallStatusRefresh
} from './use-agent-hook-install-status-refresh'

const installed: AgentHookInstallStatus = {
  agent: 'claude',
  state: 'installed',
  configPath: '/home/user/.claude/settings.json',
  managedHooksPresent: true,
  detail: null
}

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
    useAppStore.setState({ agentHookInstallStateByTarget: {} })
    setVisibility('visible')
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
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

  it('does not overlap a focus refresh with an in-flight read', async () => {
    let resolveRead: ((statuses: AgentHookInstallStatus[]) => void) | undefined
    readStatuses.mockReturnValueOnce(
      new Promise<AgentHookInstallStatus[]>((resolve) => {
        resolveRead = resolve
      })
    )
    renderHook(() => useAgentHookInstallStatusRefresh())

    window.dispatchEvent(new Event('focus'))
    expect(readStatuses).toHaveBeenCalledTimes(1)

    resolveRead?.([installed])
    await flushRefresh()
    expect(readStatuses).toHaveBeenCalledTimes(1)
  })
})
