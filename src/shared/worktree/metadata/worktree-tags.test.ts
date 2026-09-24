import { describe, expect, it } from 'vitest'
import {
  MAX_WORKTREE_TAG_LENGTH,
  MAX_WORKTREE_TAGS,
  applyNormalizedWorktreeTags,
  normalizeWorktreeTag,
  normalizeWorktreeTags,
  worktreeTagKey
} from './worktree-tags'

describe('normalizeWorktreeTag', () => {
  it('trims and collapses inner whitespace', () => {
    expect(normalizeWorktreeTag('  billing   migration \n')).toBe('billing migration')
  })

  it('rejects non-strings and blanks', () => {
    expect(normalizeWorktreeTag(42)).toBe('')
    expect(normalizeWorktreeTag(null)).toBe('')
    expect(normalizeWorktreeTag('   ')).toBe('')
  })

  it('never splits a character outside the BMP at the length cap', () => {
    const tag = normalizeWorktreeTag(`${'a'.repeat(MAX_WORKTREE_TAG_LENGTH - 1)}😀😀`)
    expect(tag).toBe(`${'a'.repeat(MAX_WORKTREE_TAG_LENGTH - 1)}😀`)
    expect(tag.isWellFormed()).toBe(true)
  })

  it('caps the length without leaving trailing whitespace', () => {
    const tag = normalizeWorktreeTag(`${'a'.repeat(MAX_WORKTREE_TAG_LENGTH - 1)} tail`)
    expect(tag).toBe('a'.repeat(MAX_WORKTREE_TAG_LENGTH - 1))
  })
})

describe('normalizeWorktreeTags', () => {
  it('dedupes case-insensitively and keeps the first spelling', () => {
    expect(normalizeWorktreeTags(['Billing', 'billing ', 'API', 'BILLING', 'api'])).toEqual([
      'Billing',
      'API'
    ])
  })

  it('drops invalid entries and non-array input', () => {
    expect(normalizeWorktreeTags(['ok', '', 7, null, '  '])).toEqual(['ok'])
    expect(normalizeWorktreeTags('ok')).toEqual([])
    expect(normalizeWorktreeTags(undefined)).toEqual([])
  })

  it('caps the number of tags', () => {
    const many = Array.from({ length: MAX_WORKTREE_TAGS + 5 }, (_, index) => `t${index}`)
    expect(normalizeWorktreeTags(many)).toHaveLength(MAX_WORKTREE_TAGS)
  })
})

describe('worktreeTagKey', () => {
  it('treats spelling variants as one tag', () => {
    expect(worktreeTagKey(' Billing  Migration')).toBe(worktreeTagKey('billing migration'))
  })

  it('does not depend on the host locale', () => {
    expect(worktreeTagKey('CI')).toBe('ci')
  })
})

describe('applyNormalizedWorktreeTags', () => {
  it('leaves records without a tags key untouched', () => {
    const record: { name: string; tags?: string[] } = { name: 'x' }
    expect(applyNormalizedWorktreeTags(record)).toBe(record)
    expect('tags' in record).toBe(false)
  })

  it('stores an empty list as an absent key', () => {
    const record: { tags?: string[] } = { tags: ['  ', ''] }
    applyNormalizedWorktreeTags(record)
    expect('tags' in record).toBe(false)
  })

  it('normalizes a non-empty list in place', () => {
    const record: { tags?: string[] } = { tags: [' web ', 'Web', 'api'] }
    applyNormalizedWorktreeTags(record)
    expect(record.tags).toEqual(['web', 'api'])
  })
})
