// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '../../store'

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => ''
}))

vi.mock('./ProviderDetailsMenu', () => ({
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'close-all-context-menus',
  useStatusBarMenuFocusHandoff: () => ({
    reset: () => {},
    onPointerDownOutside: () => {},
    onCloseAutoFocus: () => {}
  })
}))

vi.mock('./status-bar-container-observer', () => ({
  observeStatusBarContainer: () => ({ disconnect: () => {} })
}))

import { useStatusBarController } from './use-status-bar-controller'

const initialState = useAppStore.getState()

const mocks = {
  refreshRateLimits: vi.fn(async () => {}),
  refreshDetectedAgents: vi.fn(async () => []),
  // Why: the controller ensures agent detection on mount; keep that out of the refresh assertions.
  ensureDetectedAgents: vi.fn(async () => []),
  fetchInactiveClaudeAccountUsage: vi.fn(async () => {}),
  fetchInactiveCodexAccountUsage: vi.fn(async () => {})
}

describe('useStatusBarController refresh', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockClear()
    }
    useAppStore.setState({
      settings: getDefaultSettings('/tmp'),
      ...mocks
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('refreshes saved-but-inactive accounts along with the active providers (#14833)', async () => {
    const { result } = renderHook(() => useStatusBarController(false))

    await act(async () => {
      await result.current!.handleRefresh()
    })

    expect(mocks.refreshRateLimits).toHaveBeenCalledTimes(1)
    expect(mocks.refreshDetectedAgents).toHaveBeenCalledTimes(1)
    expect(mocks.fetchInactiveClaudeAccountUsage).toHaveBeenCalledTimes(1)
    expect(mocks.fetchInactiveCodexAccountUsage).toHaveBeenCalledTimes(1)
  })

  it('does not hold the spinner on the staggered inactive probes', async () => {
    let releaseCodexProbe: () => void = () => {}
    mocks.fetchInactiveCodexAccountUsage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseCodexProbe = resolve
        })
    )
    const { result } = renderHook(() => useStatusBarController(false))

    await act(async () => {
      await result.current!.handleRefresh()
    })

    // Active providers are done, so refreshing is over even though the Codex probe is still running.
    expect(result.current!.isRefreshing).toBe(false)
    releaseCodexProbe()
  })

  it('leaves inactive-account caches alone while a remote environment owns the accounts', async () => {
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'env-1' }
    })
    const { result } = renderHook(() => useStatusBarController(false))

    await act(async () => {
      await result.current!.handleRefresh()
    })

    expect(mocks.refreshRateLimits).toHaveBeenCalledTimes(1)
    expect(mocks.fetchInactiveClaudeAccountUsage).not.toHaveBeenCalled()
    expect(mocks.fetchInactiveCodexAccountUsage).not.toHaveBeenCalled()
  })
})
