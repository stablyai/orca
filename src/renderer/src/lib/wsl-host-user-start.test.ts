import { beforeEach, describe, expect, it, vi } from 'vitest'

const { connectWslHost, toastError } = vi.hoisted(() => ({
  connectWslHost: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ wslHostStatuses: {} }) } }))
vi.mock('@/components/status-bar/runtime-environment-explicit-connect', () => {
  throw new Error('Could not load the reconnect module.')
})

import { startWslHostAndReloadProjects } from './wsl-host-user-start'

beforeEach(() => {
  connectWslHost.mockReset().mockResolvedValue(undefined)
  toastError.mockReset()
  Object.assign(globalThis, {
    window: { api: { runtimeEnvironments: { wslHosts: { connect: connectWslHost } } } }
  })
})

describe('startWslHostAndReloadProjects', () => {
  it('toasts and resolves false when the reconnect module fails to load', async () => {
    await expect(startWslHostAndReloadProjects('env-1')).resolves.toBe(false)
    expect(connectWslHost).toHaveBeenCalledOnce()
    expect(toastError).toHaveBeenCalledOnce()
  })
})
