// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import {
  ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY,
  markOrchestrationSetupComplete
} from '@/lib/orchestration-setup-state'
import { useFloatingTerminalOrchestrationVisibility } from './use-floating-terminal-orchestration-visibility'

function makeCliStatus(overrides: Partial<CliInstallStatus> = {}): CliInstallStatus {
  return {
    platform: 'linux',
    commandName: 'orca',
    commandPath: '/usr/local/bin/orca',
    pathDirectory: '/usr/local/bin',
    pathConfigured: true,
    launcherPath: '/opt/Orca/orca',
    installMethod: 'symlink',
    supported: true,
    state: 'installed',
    currentTarget: null,
    unsupportedReason: null,
    detail: null,
    ...overrides
  }
}

function renderVisibility(open = true, initialVisible = false) {
  const mountedRef = { current: true }
  return renderHook(
    ({ open }) => {
      const [visible, setShowOrchestrationSetup] = useState(initialVisible)
      const { refreshOrchestrationSetupVisibility } = useFloatingTerminalOrchestrationVisibility({
        mountedRef,
        setShowOrchestrationSetup,
        open
      })
      return { visible, refreshOrchestrationSetupVisibility }
    },
    { initialProps: { open } }
  )
}

describe('useFloatingTerminalOrchestrationVisibility', () => {
  const getInstallStatus = vi.fn<() => Promise<CliInstallStatus>>()

  beforeEach(() => {
    window.localStorage.clear()
    getInstallStatus.mockReset().mockResolvedValue(makeCliStatus())
    Reflect.set(window, 'api', { cli: { getInstallStatus } })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    Reflect.deleteProperty(window, 'api')
  })

  it('hides completed setup in browser mode across close and reopen', async () => {
    markOrchestrationSetupComplete()
    getInstallStatus.mockResolvedValue(
      makeCliStatus({
        commandPath: null,
        pathDirectory: null,
        pathConfigured: false,
        launcherPath: null,
        installMethod: null,
        supported: false,
        state: 'unsupported',
        unsupportedReason: 'launch_mode_unavailable'
      })
    )
    const { result, rerender } = renderVisibility(true, true)
    await waitFor(() => expect(result.current.visible).toBe(false))
    rerender({ open: false })
    rerender({ open: true })
    await waitFor(() => expect(getInstallStatus).toHaveBeenCalledTimes(2))
    expect(result.current.visible).toBe(false)
  })

  const repairStatuses: Partial<CliInstallStatus>[] = [
    { pathConfigured: false },
    { state: 'not_installed' },
    { state: 'stale' },
    { state: 'conflict' },
    { state: 'unsupported', unsupportedReason: 'launcher_missing' },
    { state: 'unsupported', unsupportedReason: 'platform_not_supported' },
    { state: 'unsupported', unsupportedReason: 'wsl_unreachable' },
    { state: 'unsupported', unsupportedReason: null },
    { state: 'not_installed', unsupportedReason: 'launch_mode_unavailable' }
  ]

  it.each(repairStatuses)('retains CLI repair for %j after skill detection', async (status) => {
    markOrchestrationSetupComplete()
    getInstallStatus.mockResolvedValue(makeCliStatus(status))
    const { result } = renderVisibility()
    await waitFor(() => expect(result.current.visible).toBe(true))
  })

  it('shows setup without a skill marker even in browser mode', async () => {
    getInstallStatus.mockResolvedValue(
      makeCliStatus({ state: 'unsupported', unsupportedReason: 'launch_mode_unavailable' })
    )
    const { result } = renderVisibility()
    await waitFor(() => expect(result.current.visible).toBe(true))
    expect(getInstallStatus).not.toHaveBeenCalled()
  })

  it('refreshes when real skill detection marks setup complete', async () => {
    const { result } = renderVisibility()
    await waitFor(() => expect(result.current.visible).toBe(true))
    await act(async () => markOrchestrationSetupComplete())
    await waitFor(() => expect(result.current.visible).toBe(false))
  })

  it('honors explicit dismissal without querying CLI status', async () => {
    localStorage.setItem(ORCHESTRATION_SETUP_DISMISSED_STORAGE_KEY, '1')
    const { result } = renderVisibility(true, true)
    await waitFor(() => expect(result.current.visible).toBe(false))
    expect(getInstallStatus).not.toHaveBeenCalled()
  })

  it('retains setup when the CLI status request fails', async () => {
    markOrchestrationSetupComplete()
    getInstallStatus.mockRejectedValue(new Error('CLI status unavailable'))
    const { result } = renderVisibility()
    await waitFor(() => expect(result.current.visible).toBe(true))
  })

  it('ignores a pending status after its mounted owner is disposed', async () => {
    markOrchestrationSetupComplete()
    let resolveStatus: ((status: CliInstallStatus) => void) | undefined
    getInstallStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve
      })
    )
    const mountedRef = { current: true }
    const setShowOrchestrationSetup = vi.fn()
    const { unmount } = renderHook(() =>
      useFloatingTerminalOrchestrationVisibility({
        mountedRef,
        setShowOrchestrationSetup,
        open: true
      })
    )
    mountedRef.current = false
    unmount()
    await act(async () => resolveStatus?.(makeCliStatus()))
    expect(setShowOrchestrationSetup).not.toHaveBeenCalled()
  })
})
