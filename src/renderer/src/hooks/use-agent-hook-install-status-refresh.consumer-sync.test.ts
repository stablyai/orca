// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import * as observability from '@/components/sidebar/worktree-hook-observability'
import { installed, liveConsumerState, workspaceId } from './agent-hook-refresh.test-fixture'
import { useAgentHookInstallStatusRefresh } from './use-agent-hook-install-status-refresh'

vi.mock('@/lib/renderer-app-platform', () => ({ getRendererAppPlatform: () => 'win32' }))

async function flushRefresh(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

function disabledConsumerState(kind: 'settings' | 'PTY' | 'tab' | 'host'): Partial<AppState> {
  const state = useAppStore.getState()
  if (kind === 'settings') {
    return { settings: state.settings && { ...state.settings, agentStatusHooksEnabled: false } }
  }
  if (kind === 'PTY') {
    return { ptyIdsByTabId: {} }
  }
  if (kind === 'tab') {
    return { tabsByWorktree: {} }
  }
  return {
    folderWorkspaces: state.folderWorkspaces.map((folder) => ({ ...folder, connectionId: 'ssh-1' }))
  }
}

const eligibilityInputs = [
  'activeRepoId',
  'activeWorktreeId',
  'folderWorkspaces',
  'projectGroups',
  'projects',
  'ptyIdsByTabId',
  'repos',
  'settings',
  'tabsByWorktree',
  'worktreesByRepo'
] as const

describe('useAgentHookInstallStatusRefresh consumer subscription', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState({ ...liveConsumerState(), activeRepoId: null, activeWorktreeId: null })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible'
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not re-traverse consumers for its snapshot or unrelated real-store writes', async () => {
    const selectConsumers = vi.spyOn(observability, 'selectHasAgentHookInstallStatusConsumer')
    const readStatuses = vi.fn().mockResolvedValue([installed])
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { agentHooks: { installStatuses: readStatuses } }
    })
    renderHook(() => useAgentHookInstallStatusRefresh())
    await flushRefresh()
    expect(readStatuses).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().agentHookInstallStateByTarget).toEqual({ claude: 'installed' })
    expect(selectConsumers).toHaveBeenCalledTimes(1)

    act(() => {
      for (let index = 0; index < 20; index++) {
        useAppStore.setState({ sidebarWidth: 300 + index })
        useAppStore.setState({ agentStatusByPaneKey: {} })
        useAppStore.getState().setAgentHookInstallStatuses([{ ...installed, state: 'partial' }])
      }
    })
    await flushRefresh()
    expect(selectConsumers).toHaveBeenCalledTimes(1)
    expect(readStatuses).toHaveBeenCalledTimes(1)
  })

  it.each(eligibilityInputs)('re-traverses when eligibility input %s changes', async (key) => {
    const selectConsumers = vi.spyOn(observability, 'selectHasAgentHookInstallStatusConsumer')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { agentHooks: { installStatuses: vi.fn().mockResolvedValue([]) } }
    })
    renderHook(() => useAgentHookInstallStatusRefresh())
    await flushRefresh()
    selectConsumers.mockClear()
    act(() => {
      const state = useAppStore.getState()
      if (key === 'activeRepoId' || key === 'activeWorktreeId') {
        useAppStore.setState({ [key]: workspaceId })
      } else if (
        key === 'folderWorkspaces' ||
        key === 'projectGroups' ||
        key === 'projects' ||
        key === 'repos'
      ) {
        useAppStore.setState({ [key]: [...state[key]] })
      } else if (key === 'settings') {
        useAppStore.setState({ settings: state.settings && { ...state.settings } })
      } else {
        useAppStore.setState({ [key]: { ...state[key] } })
      }
    })
    expect(selectConsumers).toHaveBeenCalledTimes(1)
  })

  it.each(['settings', 'PTY', 'tab', 'host'] as const)(
    'starts and stops scans when %s eligibility changes',
    async (kind) => {
      const initial = liveConsumerState()
      useAppStore.setState(disabledConsumerState(kind))
      const readStatuses = vi.fn().mockResolvedValue([installed])
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { agentHooks: { installStatuses: readStatuses } }
      })
      renderHook(() => useAgentHookInstallStatusRefresh())
      await flushRefresh()
      expect(readStatuses).not.toHaveBeenCalled()

      act(() => useAppStore.setState(initial))
      await flushRefresh()
      expect(readStatuses).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(1)
      act(() => useAppStore.setState(disabledConsumerState(kind)))
      await flushRefresh()
      expect(vi.getTimerCount()).toBe(0)
      expect(readStatuses).toHaveBeenCalledTimes(1)
    }
  )
})
