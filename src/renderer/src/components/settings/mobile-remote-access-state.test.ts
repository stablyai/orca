import { describe, expect, it } from 'vitest'
import { parseMobileRuntimeEndpointPort } from './mobile-remote-access-state'

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
