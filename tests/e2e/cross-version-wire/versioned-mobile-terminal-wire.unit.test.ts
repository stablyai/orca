import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { materializeReleaseCheckout, resolveBaselineReleaseRef } from './release-checkout'
import { loadMobileTerminalWireBuild } from './versioned-mobile-terminal-wire'
import { WORKING_TREE } from './versioned-terminal-wire'

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => new Uint8Array(randomBytes(length))
}))

describe('versioned mobile terminal wire provenance', () => {
  it('loads distinct released endpoints and keeps mobile extraction bounded', async () => {
    const ref = resolveBaselineReleaseRef()
    const checkout = await materializeReleaseCheckout(ref)
    const [current, released] = await Promise.all([
      loadMobileTerminalWireBuild(WORKING_TREE),
      loadMobileTerminalWireBuild(ref)
    ])
    expect(released.revision).toBe(checkout.commit)
    expect(released.label).toBe(ref)
    for (const key of [
      'E2EEChannel',
      'RpcDispatcher',
      'MobileE2EEV2ClientSession',
      'MobileE2EEV2PhysicalChannel',
      'MobileRelayRpcStreams'
    ] as const) {
      expect(released[key], `${ref} ${key}`).toBeTypeOf('function')
      expect(released[key], `${ref} ${key} must not borrow the working tree`).not.toBe(current[key])
    }
    expect(existsSync(join(checkout.root, 'mobile', 'src', 'components'))).toBe(false)
    const source = readFileSync(
      join(checkout.root, 'mobile', 'src', 'transport', 'mobile-relay-rpc-streams.ts'),
      'utf8'
    )
    const releasedStreams = new released.MobileRelayRpcStreams({
      nextId: () => 'probe',
      sendFrame: () => true,
      waitForConnected: async () => undefined
    })
    try {
      expect(typeof releasedStreams.sendTerminalStreamInput === 'function').toBe(
        source.includes('sendTerminalStreamInput(')
      )
    } finally {
      releasedStreams.clear()
    }
  })
})
