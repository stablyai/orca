import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { WslHostCapability } from '../../../../shared/wsl-host-types'
import { seedStore } from '../../store/slices/store-test-helpers'

vi.mock('../../store', async () => {
  const { createTestStore } = await import('../../store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

const { useAppStore } = await import('../../store')
const { registerWslHostIpcBridge } = await import('./wsl-host-ipc-bridge')
const { readWslHostOfferGate, wslHostOfferFor } =
  await import('../../components/sidebar/wsl-host-offer')

let pushCapability: (capability: WslHostCapability) => void = () => {}
const api = {
  onStatusChanged: vi.fn(() => () => {}),
  getStatuses: vi.fn(async () => []),
  getCapability: vi.fn(async () => ({ serverFiles: true, acceptsNewWork: true })),
  onCapabilityChanged: vi.fn((callback: (capability: WslHostCapability) => void) => {
    pushCapability = callback
    return () => {}
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { window: { api: { runtimeEnvironments: { wslHosts: api } } } })
  seedStore(useAppStore, {
    settings: { ...getDefaultSettings('/tmp'), experimentalWslHosts: false }
  })
})

describe('WSL host capability pushed mid-run', () => {
  it('hides the in-context offer as soon as main stops new work, without a relaunch', async () => {
    const unsubs: (() => void)[] = []
    registerWslHostIpcBridge(unsubs)
    await vi.waitFor(() => expect(useAppStore.getState().wslHostsAcceptNewWork).toBe(true))
    const uncPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\app'
    expect(wslHostOfferFor(uncPath, readWslHostOfferGate(useAppStore.getState()))).toBe('Ubuntu')

    pushCapability({ serverFiles: true, acceptsNewWork: false })

    expect(useAppStore.getState().wslHostsAcceptNewWork).toBe(false)
    expect(wslHostOfferFor(uncPath, readWslHostOfferGate(useAppStore.getState()))).toBeNull()
    unsubs.forEach((unsub) => unsub())
  })
})
