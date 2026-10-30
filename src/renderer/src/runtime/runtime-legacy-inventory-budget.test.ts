import { describe, expect, it } from 'vitest'
import { decodeLegacyQuickOpenInventory } from './runtime-legacy-inventory-budget'

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
})
