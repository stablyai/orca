import { describe, expect, it } from 'vitest'
import { readProviderRelayDetachPolicy } from '../../main/daemon/provider-relay/provider-relay-detach-policy'
import { jsonObject, jsonProperty } from './json-value-property'

describe('JSON object own properties', () => {
  it('does not promote JSON data into inherited detach policy fields', () => {
    expect(
      readProviderRelayDetachPolicy(JSON.parse('{"__proto__":{"idleStopMs":1,"markers":[]}}'))
    ).toBeNull()
    expect(readProviderRelayDetachPolicy({ idleStopMs: 1000, markers: [] })).toEqual({
      idleStopMs: 1000,
      markers: []
    })
  })

  it('retains a literal __proto__ property as JSON data', () => {
    const parsed = JSON.parse('{"__proto__":{"value":42},"ordinary":"kept"}')
    const copied = jsonObject(parsed)
    expect(jsonProperty(copied, '__proto__')).toEqual({ value: 42 })
    expect(JSON.stringify(copied)).toBe(JSON.stringify(parsed))
    expect(copied?.value).toBeUndefined()
  })
})
