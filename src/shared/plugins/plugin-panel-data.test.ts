import { describe, expect, it } from 'vitest'
import { isPluginPanelData } from './plugin-panel-data'

describe('panel JSON data', () => {
  it('accepts JSON primitives, nested data and repeated references', () => {
    const value = { count: 1 }
    for (const data of [null, false, 0, 'hello', [], { a: [value], b: value }]) {
      expect(isPluginPanelData(data)).toBe(true)
    }
  })

  it('rejects values JSON would silently change or omit', () => {
    for (const data of [
      undefined,
      Number.NaN,
      Infinity,
      () => 1,
      BigInt(1),
      new Date(),
      new Map(),
      Array(2),
      { value: undefined },
      [undefined]
    ]) {
      expect(isPluginPanelData(data)).toBe(false)
    }
  })

  it('bounds cycles, depth, UTF-8 and JSON escaping before serialization', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(isPluginPanelData(cyclic)).toBe(false)
    let deep: unknown = null
    for (let i = 0; i < 150; i++) {
      deep = [deep]
    }
    expect(isPluginPanelData(deep)).toBe(false)
    expect(isPluginPanelData('😀'.repeat(17000))).toBe(false)
    expect(isPluginPanelData('\u0000'.repeat(12000))).toBe(false)
    expect(isPluginPanelData('x'.repeat(65000))).toBe(true)
  })
})
