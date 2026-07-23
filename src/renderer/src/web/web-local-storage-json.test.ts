import { describe, expect, it, vi } from 'vitest'
import {
  parseWebLocalStorageJson,
  stringifyWebLocalStorageJson,
  WEB_LOCAL_STORAGE_JSON_LIMITS,
  type WebLocalStorageJsonLimits
} from './web-local-storage-json'

describe('browser-local JSON memory admission', () => {
  it('preserves ordinary JSON serialization and parsing', () => {
    const value = {
      escaped: '\u0000\n',
      nested: [1, true, null, { emoji: '🐋' }],
      omitted: undefined
    }
    const serialized = JSON.stringify(value)

    expect(stringifyWebLocalStorageJson(value)).toBe(serialized)
    expect(parseWebLocalStorageJson(serialized)).toEqual(JSON.parse(serialized))
  })

  it('accepts exact UTF-8 bytes and rejects the next byte', () => {
    const limits = createLimits({ maxBytes: 6 })

    expect(parseWebLocalStorageJson('"🐋"', limits)).toBe('🐋')
    expect(stringifyWebLocalStorageJson('🐋', limits)).toBe('"🐋"')
    expect(() => parseWebLocalStorageJson('"🐋x"', limits)).toThrow(
      'Browser-local JSON exceeds 6 bytes'
    )
    expect(() => stringifyWebLocalStorageJson('🐋x', limits)).toThrow(
      'Browser-local JSON exceeds 6 bytes'
    )
  })

  it('admits exact structure and depth while rejecting the next token or level', () => {
    const structuralLimits = createLimits({ structuralTokens: 4 })
    const depthLimits = createLimits({ nestingDepth: 3 })

    expect(parseWebLocalStorageJson('[0,0,0]', structuralLimits)).toEqual([0, 0, 0])
    expect(stringifyWebLocalStorageJson([0, 0, 0], structuralLimits)).toBe('[0,0,0]')
    expect(() => parseWebLocalStorageJson('[0,0,0,0]', structuralLimits)).toThrow(
      'JSON structure exceeds 4 tokens'
    )
    expect(() => stringifyWebLocalStorageJson([0, 0, 0, 0], structuralLimits)).toThrow(
      'JSON structure exceeds 4 tokens'
    )
    expect(parseWebLocalStorageJson('[[[]]]', depthLimits)).toEqual([[[]]])
    expect(() => parseWebLocalStorageJson('[[[[]]]]', depthLimits)).toThrow(
      'JSON nesting exceeds 3 levels'
    )
  })

  it('rejects amplified input before invoking JSON.parse', () => {
    const parse = vi.spyOn(JSON, 'parse')

    expect(() =>
      parseWebLocalStorageJson('[0,0,0,0]', createLimits({ structuralTokens: 4 }))
    ).toThrow('JSON structure exceeds 4 tokens')
    expect(parse).not.toHaveBeenCalled()
  })

  it('stops output traversal once the byte limit is exceeded', () => {
    const readAfter = vi.fn(() => 'late')
    const value = {
      payload: 'x'.repeat(100),
      get after() {
        return readAfter()
      }
    }

    expect(() => stringifyWebLocalStorageJson(value, createLimits({ maxBytes: 32 }))).toThrow(
      'Browser-local JSON exceeds 32 bytes'
    )
    expect(readAfter).not.toHaveBeenCalled()
  })

  it('keeps a finite default persistence envelope', () => {
    expect(WEB_LOCAL_STORAGE_JSON_LIMITS).toEqual({
      maxBytes: 8 * 1024 * 1024,
      structuralTokens: 1_000_000,
      nestingDepth: 128
    })
  })
})

function createLimits(overrides: Partial<WebLocalStorageJsonLimits>): WebLocalStorageJsonLimits {
  return {
    maxBytes: 1_000,
    structuralTokens: 100,
    nestingDepth: 10,
    ...overrides
  }
}
