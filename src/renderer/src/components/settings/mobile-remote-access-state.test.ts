import { describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../../shared/ssh-types'
import {
  formatMobileRemoteTargetLabel,
  parseMobileRemotePort,
  parseMobileRuntimeEndpointPort
} from './mobile-remote-access-state'

function createSshTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'relay',
    label: 'Relay',
    host: '1.2.3.4',
    port: 22,
    username: 'root',
    ...overrides
  }
}

describe('formatMobileRemoteTargetLabel', () => {
  it('uses the ssh config alias when available', () => {
    expect(formatMobileRemoteTargetLabel(createSshTarget({ configHost: 'relay-alias' }))).toBe(
      'Relay (root@relay-alias)'
    )
  })

  it('falls back to the host when no ssh config alias is set', () => {
    expect(formatMobileRemoteTargetLabel(createSshTarget())).toBe('Relay (root@1.2.3.4)')
  })
})

describe('parseMobileRemotePort', () => {
  it('accepts valid tcp port boundaries', () => {
    expect(parseMobileRemotePort('1')).toBe(1)
    expect(parseMobileRemotePort('65535')).toBe(65535)
  })

  it('rejects missing, fractional, non-numeric, and out-of-range ports', () => {
    expect(parseMobileRemotePort('')).toBeNull()
    expect(parseMobileRemotePort('0')).toBeNull()
    expect(parseMobileRemotePort('65536')).toBeNull()
    expect(parseMobileRemotePort('12.5')).toBeNull()
    expect(parseMobileRemotePort('abc')).toBeNull()
  })
})

describe('parseMobileRuntimeEndpointPort', () => {
  it('extracts the live runtime port from websocket endpoints', () => {
    expect(parseMobileRuntimeEndpointPort('ws://0.0.0.0:6769')).toBe('6769')
    expect(parseMobileRuntimeEndpointPort('wss://[::1]:6770')).toBe('6770')
  })

  it('ignores endpoints without a valid explicit port', () => {
    expect(parseMobileRuntimeEndpointPort(null)).toBeNull()
    expect(parseMobileRuntimeEndpointPort('ws://127.0.0.1')).toBeNull()
    expect(parseMobileRuntimeEndpointPort('not-a-url')).toBeNull()
  })
})
