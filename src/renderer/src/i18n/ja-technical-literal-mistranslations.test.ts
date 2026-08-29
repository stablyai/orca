/**
 * Guards the source control "Push"/"Pull" button mistranslations so
 * bootstrap re-translation cannot silently regress them.
 */
import { describe, expect, it } from 'vitest'
import ja from './locales/ja.json'

function findByKey(node: unknown, key: string): string | undefined {
  if (!node || typeof node !== 'object') {
    return undefined
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findByKey(item, key)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }
  const record = node as Record<string, unknown>
  if (typeof record[key] === 'string') {
    return record[key] as string
  }
  for (const value of Object.values(record)) {
    const found = findByKey(value, key)
    if (found !== undefined) {
      return found
    }
  }
  return undefined
}

describe('ja technical literal / sense fixes', () => {
  it('translates the source control Push action as プッシュ, not 押す', () => {
    expect(findByKey(ja, '95550cff15')).toBe('プッシュ')
  })

  it('translates the source control Pull action as プル, not 引く', () => {
    expect(findByKey(ja, 'd64292a938')).toBe('プル')
  })
})
