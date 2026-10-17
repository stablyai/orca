// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUsePermissionStatusResult } from '../../../../shared/computer-use-permissions-types'

function status(
  accessibility: 'granted' | 'not-granted',
  screenshots: 'granted' | 'not-granted',
  helperUnavailableReason: string | null = null
): ComputerUsePermissionStatusResult {
  return {
    platform: 'darwin',
    helperAppPath: '/Applications/Orca Computer Use.app',
    helperUnavailableReason,
    permissions: [
      { id: 'accessibility', status: accessibility },
      { id: 'screenshots', status: screenshots }
    ]
  }
}

const getStatus = vi.fn<() => Promise<ComputerUsePermissionStatusResult>>()

async function loadStore() {
  vi.resetModules()
  return await import('./computer-use-permission-setup-store')
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

function focusWindow(): void {
  window.dispatchEvent(new Event('focus'))
}

describe('computer-use permission setup store', () => {
  const releases: (() => void)[] = []

  beforeEach(() => {
    getStatus.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { computerUsePermissions: { getStatus } }
    })
  })

  afterEach(() => {
    for (const release of releases.splice(0)) {
      release()
    }
  })

  it('reads once for every consumer that mounts together', async () => {
    const store = await loadStore()
    getStatus.mockResolvedValue(status('granted', 'not-granted'))

    for (let i = 0; i < 4; i++) {
      releases.push(store.watchComputerUsePermissionSetup())
    }
    await settle()

    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(store.readComputerUsePermissionSetup()).toEqual({
      checked: true,
      ready: false,
      unavailable: false
    })
  })

  it('issues one read per focus across consumers while the step is incomplete', async () => {
    const store = await loadStore()
    getStatus.mockResolvedValue(status('granted', 'not-granted'))
    releases.push(store.watchComputerUsePermissionSetup(), store.watchComputerUsePermissionSetup())
    await settle()

    focusWindow()
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()

    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it('stops re-checking on focus once permissions are granted', async () => {
    const store = await loadStore()
    getStatus.mockResolvedValue(status('granted', 'not-granted'))
    releases.push(store.watchComputerUsePermissionSetup())
    await settle()

    getStatus.mockResolvedValue(status('granted', 'granted'))
    focusWindow()
    await settle()
    expect(store.readComputerUsePermissionSetup().ready).toBe(true)

    focusWindow()
    focusWindow()
    await settle()
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it('stops re-checking on focus when the helper is unavailable', async () => {
    const store = await loadStore()
    getStatus.mockResolvedValue(status('not-granted', 'not-granted', 'missing helper'))
    releases.push(store.watchComputerUsePermissionSetup())
    await settle()

    focusWindow()
    await settle()

    expect(store.readComputerUsePermissionSetup().unavailable).toBe(true)
    expect(getStatus).toHaveBeenCalledTimes(1)
  })

  it('retries on focus after a failed read', async () => {
    const store = await loadStore()
    getStatus.mockRejectedValueOnce(new Error('timed out'))
    releases.push(store.watchComputerUsePermissionSetup())
    await settle()
    expect(store.readComputerUsePermissionSetup()).toEqual({
      checked: true,
      ready: false,
      unavailable: false
    })

    getStatus.mockResolvedValue(status('granted', 'granted'))
    focusWindow()
    await settle()

    expect(store.readComputerUsePermissionSetup().ready).toBe(true)
  })

  it('does not read on focus with no consumer and forgets the answer when the last one leaves', async () => {
    const store = await loadStore()
    getStatus.mockResolvedValue(status('granted', 'granted'))
    const release = store.watchComputerUsePermissionSetup()
    await settle()

    release()
    focusWindow()
    await settle()

    expect(getStatus).toHaveBeenCalledTimes(1)
    expect(store.readComputerUsePermissionSetup().checked).toBe(false)
  })

  it('follows a status another surface read, such as a reset in settings', async () => {
    const store = await loadStore()
    getStatus.mockResolvedValue(status('granted', 'granted'))
    releases.push(store.watchComputerUsePermissionSetup())
    await settle()

    store.recordComputerUsePermissionStatus(status('not-granted', 'not-granted'))

    expect(store.readComputerUsePermissionSetup().ready).toBe(false)
    focusWindow()
    await settle()
    expect(getStatus).toHaveBeenCalledTimes(2)
  })
})
