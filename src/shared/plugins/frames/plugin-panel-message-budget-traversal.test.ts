import { describe, expect, it } from 'vitest'
import { structuredCloneMessageBytes } from './plugin-panel-message-budget'

const factories: [string, () => Iterable<unknown>][] = [
  ['array', () => Array.from({ length: 10_000 }, (_, i) => `value-${i}`)],
  ['set', () => new Set(Array.from({ length: 10_000 }, (_, i) => `value-${i}`))],
  ['map', () => new Map(Array.from({ length: 10_000 }, (_, i) => [`key-${i}`, i]))]
]

describe('plugin message budget traversal', () => {
  it.each(factories)('stops consuming an oversized %s', (_name, create) => {
    const value = create()
    const iterate = value[Symbol.iterator].bind(value)
    let visits = 0
    value[Symbol.iterator] = function* () {
      for (const entry of { [Symbol.iterator]: iterate }) {
        visits++
        yield entry
      }
    }
    expect(structuredCloneMessageBytes(value, 64)).toBe(65)
    expect(visits).toBeLessThan(10)
  })

  it('stops reading object values after an earlier property exceeds the budget', () => {
    const value: Record<string, unknown> = { first: 'x'.repeat(1000) }
    let reads = 0
    for (let i = 0; i < 1000; i++) {
      Object.defineProperty(value, `tail-${i}`, {
        enumerable: true,
        get: () => {
          reads++
          return i
        }
      })
    }
    expect(structuredCloneMessageBytes(value, 64)).toBe(65)
    expect(reads).toBe(0)
  })

  it.each([
    ['array', [1, 2], 32],
    ['set', new Set([1, 2]), 32],
    [
      'map',
      new Map([
        ['a', 1],
        ['b', 2]
      ]),
      34
    ],
    ['object', { a: 1, b: 2 }, 26]
  ] as const)(
    'preserves the exact %s estimate at both sides of the boundary',
    (_name, value, bytes) => {
      expect(structuredCloneMessageBytes(value, bytes - 1)).toBe(bytes)
      expect(structuredCloneMessageBytes(value, bytes)).toBe(bytes)
      expect(structuredCloneMessageBytes(value, bytes + 1)).toBe(bytes)
    }
  )

  it('unwinds all enclosing collections after a nested value exceeds the cap', () => {
    let reads = 0
    const value = [new Map([['nested', new Set(['x'.repeat(1000)])]])]
    Object.defineProperty(value, 1, {
      get: () => {
        reads++
        return 1
      }
    })
    expect(structuredCloneMessageBytes(value, 64)).toBe(65)
    expect(reads).toBe(0)
  })
})
