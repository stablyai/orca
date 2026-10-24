// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { notifyCliInstallStatusChanged } from '@/lib/cli-install-status-events'
import {
  CLI_STATUS_PROBE_SETTLE_TIMEOUT_MS,
  isCliPathRegistered,
  useCliStatus
} from './use-cli-status'

const originalApi = window.api

function makeStatus(overrides: Partial<CliInstallStatus> = {}): CliInstallStatus {
  return {
    platform: 'linux',
    commandName: 'orca',
    commandPath: '/home/dev/.local/bin/orca',
    pathDirectory: '/home/dev/.local/bin',
    pathConfigured: true,
    launcherPath: '/opt/orca/orca',
    installMethod: 'symlink',
    supported: true,
    state: 'installed',
    currentTarget: null,
    unsupportedReason: null,
    detail: null,
    ...overrides
  }
}

describe('isCliPathRegistered', () => {
  it('accepts only an installed command whose directory is on the persisted PATH', () => {
    expect(isCliPathRegistered(makeStatus())).toBe(true)
    expect(isCliPathRegistered(makeStatus({ pathConfigured: false }))).toBe(false)
    expect(isCliPathRegistered(makeStatus({ pathConfigured: null }))).toBe(false)
    expect(isCliPathRegistered(makeStatus({ state: 'not_installed' }))).toBe(false)
    expect(isCliPathRegistered(makeStatus({ state: 'stale' }))).toBe(false)
    expect(isCliPathRegistered(null)).toBe(false)
  })
})

describe('useCliStatus', () => {
  const getInstallStatus = vi.fn()

  beforeEach(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only reaches window.api.cli.getInstallStatus.
    window.api = { cli: { getInstallStatus } } as unknown as typeof window.api
  })

  afterEach(() => {
    cleanup()
    getInstallStatus.mockReset()
    window.api = originalApi
  })

  it('reports the probe result once the caller is ready to render it', async () => {
    getInstallStatus.mockResolvedValue(makeStatus())
    const { result } = renderHook(() => useCliStatus(true))

    await waitFor(() => expect(result.current.cliInstallStatusChecked).toBe(true))
    expect(result.current.cliPathRegistered).toBe(true)
  })

  it('masks the probe result while the caller is not ready', async () => {
    getInstallStatus.mockResolvedValue(makeStatus())
    const { result } = renderHook(() => useCliStatus(false))

    expect(result.current).toEqual({ cliPathRegistered: false, cliInstallStatusChecked: false })
    await waitFor(() => expect(getInstallStatus).toHaveBeenCalled())
    expect(result.current.cliPathRegistered).toBe(false)
  })

  it('re-probes when the CLI section announces a status change', async () => {
    getInstallStatus.mockResolvedValue(
      makeStatus({ state: 'not_installed', pathConfigured: false })
    )
    const { result } = renderHook(() => useCliStatus(true))
    await waitFor(() => expect(result.current.cliInstallStatusChecked).toBe(true))
    expect(result.current.cliPathRegistered).toBe(false)

    getInstallStatus.mockResolvedValue(makeStatus())
    act(() => notifyCliInstallStatusChanged())

    await waitFor(() => expect(result.current.cliPathRegistered).toBe(true))
  })

  it('settles readiness as unregistered when the probe never answers', async () => {
    vi.useFakeTimers()
    try {
      getInstallStatus.mockReturnValue(new Promise(() => {}))
      const { result } = renderHook(() => useCliStatus(true))
      expect(result.current.cliInstallStatusChecked).toBe(false)

      act(() => {
        vi.advanceTimersByTime(CLI_STATUS_PROBE_SETTLE_TIMEOUT_MS)
      })

      expect(result.current).toEqual({ cliPathRegistered: false, cliInstallStatusChecked: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores an older probe that resolves after a newer one', async () => {
    let resolveFirst: (status: CliInstallStatus) => void = () => {}
    getInstallStatus.mockReturnValueOnce(
      new Promise<CliInstallStatus>((resolve) => {
        resolveFirst = resolve
      })
    )
    getInstallStatus.mockResolvedValueOnce(makeStatus())
    const { result } = renderHook(() => useCliStatus(true))

    act(() => notifyCliInstallStatusChanged())
    await waitFor(() => expect(result.current.cliPathRegistered).toBe(true))

    await act(async () => {
      resolveFirst(makeStatus({ state: 'not_installed', pathConfigured: false }))
    })
    expect(result.current.cliPathRegistered).toBe(true)
  })
})
