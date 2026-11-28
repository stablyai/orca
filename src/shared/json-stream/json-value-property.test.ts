import { describe, expect, it } from 'vitest'
import { jsonObject } from './json-value-property'

describe('jsonObject', () => {
  it('keeps a parsed __proto__ key as own data instead of inherited fields', () => {
    const text = '{"__proto__":{"idleStopMs":1},"ordinary":"kept"}'
    const copied = jsonObject(JSON.parse(text))
    expect(copied?.idleStopMs).toBeUndefined()
    expect(JSON.stringify(copied)).toBe(text)
  })
})
