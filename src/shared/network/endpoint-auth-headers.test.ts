import { describe, expect, it } from 'vitest'
import { endpointAuthOrigin, normalizeEndpointAuthHeaders } from './endpoint-auth-headers'

describe('shared endpoint authentication validation', () => {
  it('binds implicit and explicit secure ports while ignoring the route', () => {
    expect(endpointAuthOrigin('wss://ORCA.example:443/route?key=synthetic')).toBe(
      'wss://orca.example'
    )
    expect(endpointAuthOrigin('wss://orca.example:8443')).toBe('wss://orca.example:8443')
    expect(endpointAuthOrigin('ws://orca.example')).toBeNull()
    expect(endpointAuthOrigin('wss://user:secret@orca.example')).toBeNull()
  })

  it('normalizes duplicate names and treats prototype names as data', () => {
    const normalized = normalizeEndpointAuthHeaders([
      { name: ' X-Token ', value: ' first ' },
      { name: 'x-token', value: 'second' },
      { name: '__proto__', value: 'synthetic' }
    ])
    expect(normalized).toEqual({
      ok: true,
      headers: JSON.parse('{"x-token":"second","__proto__":"synthetic"}')
    })
    if (normalized.ok) {
      expect(Object.getPrototypeOf(normalized.headers)).toBe(Object.prototype)
    }
  })

  it.each(['line\r\nbreak', 'tab\tvalue', 'unicode-☃', 'x'.repeat(1025)])(
    'rejects unsafe header values',
    (value) => {
      const result = normalizeEndpointAuthHeaders([{ name: 'X-Token', value }])
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(value)
    }
  )

  it('bounds header count and name length', () => {
    expect(
      normalizeEndpointAuthHeaders(
        Array.from({ length: 9 }, (_, i) => ({ name: `X-${i}`, value: 'value' }))
      ).ok
    ).toBe(false)
    expect(normalizeEndpointAuthHeaders([{ name: 'x'.repeat(129), value: 'value' }]).ok).toBe(false)
  })
})
