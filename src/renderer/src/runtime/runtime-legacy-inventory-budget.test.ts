import { describe, expect, it } from 'vitest'
import {
  decodeLegacyQuickOpenInventory,
  pruneLegacyInventoryCache
} from './runtime-legacy-inventory-budget'

function inventory(count = 1) {
  return {
    worktree: 'folder:one',
    rootPath: '/repo',
    totalCount: count,
    truncated: false,
    files: Array.from({ length: count }, (_, index) => ({
      relativePath: `src/file-${index}.ts`,
      basename: `file-${index}.ts`,
      kind: 'text'
    }))
  }
}

describe('complete legacy inventory retention', () => {
  it('retains a full valid inventory beyond 20,000 and discards unknown payload fields', () => {
    const value = inventory(25_002)
    Object.assign(value.files[0], { extra: { nested: 'x'.repeat(1000) } })
    const { result, retainedBytes } = decodeLegacyQuickOpenInventory(value)
    expect(result.files).toHaveLength(25_002)
    expect(result.files[25_001].relativePath).toBe('src/file-25001.ts')
    expect(result.files[0]).not.toHaveProperty('extra')
    expect(retainedBytes).toBeGreaterThan(25_002 * 128)
  })
  it('fails oversized complete responses instead of retaining a prefix', () => {
    expect(() => decodeLegacyQuickOpenInventory(inventory(10), 1024)).toThrow('too large')
    expect(() =>
      decodeLegacyQuickOpenInventory({ ...inventory(0), rootPath: 'x'.repeat(1000) }, 1024)
    ).toThrow('too large')
    const value = inventory()
    value.files[0].relativePath = 'x'.repeat(65_537)
    expect(() => decodeLegacyQuickOpenInventory(value)).toThrow('too large')
  })
  it.each([
    null,
    { files: [] },
    { ...inventory(), totalCount: 0 },
    { ...inventory(), files: [{ relativePath: 12 }] }
  ])('rejects malformed responses %j', (value) => {
    expect(() => decodeLegacyQuickOpenInventory(value)).toThrow('Invalid remote file inventory')
  })
  it('evicts in access order under a shared byte allowance and releases removed accounting', () => {
    const cache = new Map([
      ['one', { retainedBytes: 60 }],
      ['two', { retainedBytes: 60 }]
    ])
    pruneLegacyInventoryCache(cache, 8, 100)
    expect([...cache.keys()]).toEqual(['two'])
    cache.delete('two')
    cache.set('three', { retainedBytes: 100 })
    pruneLegacyInventoryCache(cache, 8, 100)
    expect([...cache.keys()]).toEqual(['three'])
    cache.set('three', { retainedBytes: 10 })
    cache.set('owner-changed', { retainedBytes: 90 })
    pruneLegacyInventoryCache(cache, 8, 100)
    expect(cache.size).toBe(2)
  })
})
