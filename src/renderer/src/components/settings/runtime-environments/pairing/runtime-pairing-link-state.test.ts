import { describe, expect, it } from 'vitest'
import {
  followedRuntimePairingInterface,
  resolveAnotherDeviceAddress
} from './runtime-pairing-link-state'

const ETHERNET = { name: 'en0', address: '192.168.4.191' }
const THUNDERBOLT = { name: 'bridge0', address: '10.99.88.1' }
const TAILSCALE = { name: 'utun4', address: '100.64.0.5' }

describe('resolveAnotherDeviceAddress', () => {
  it('keeps a chosen Thunderbolt Bridge address through restart and dropout', () => {
    // Discovery ranks bridge0 last, so the old fallback picked Ethernet.
    const afterRestart = resolveAnotherDeviceAddress([ETHERNET, THUNDERBOLT], '', THUNDERBOLT)
    expect(afterRestart).toBe('10.99.88.1')

    const duringDropout = resolveAnotherDeviceAddress([ETHERNET], afterRestart, THUNDERBOLT)
    expect(duringDropout).toBe('10.99.88.1')

    expect(resolveAnotherDeviceAddress([ETHERNET, THUNDERBOLT], duringDropout, THUNDERBOLT)).toBe(
      '10.99.88.1'
    )
  })

  it('uses the top-ranked address when nothing was chosen or listed', () => {
    expect(resolveAnotherDeviceAddress([TAILSCALE, ETHERNET], '', null)).toBe('100.64.0.5')
    expect(resolveAnotherDeviceAddress([], '', THUNDERBOLT)).toBe('')
  })

  it('follows the chosen interface to its new address when it returns on a new IPv4', () => {
    const renumberedBridge = { name: 'bridge0', address: '10.99.77.1' }
    const interfaces = [ETHERNET, renumberedBridge]

    const address = resolveAnotherDeviceAddress(interfaces, '', THUNDERBOLT)
    expect(address).toBe('10.99.77.1')
    expect(followedRuntimePairingInterface(interfaces, address, THUNDERBOLT)).toEqual(
      renumberedBridge
    )
  })
})
