import { describe, expect, it } from 'vitest'
import type { GitBranchCompareSummary } from '../../../../shared/git-diff-compare-types'
import { toBranchCompareSnapshot } from '@/store/slices/editor/git/git-status-reconciliation'
import {
  buildActiveOpenFileSignature,
  buildActiveOpenRowKeys
} from './source-control/listing/active-open-file-keys'

const branchSummary: GitBranchCompareSummary = {
  baseRef: 'main',
  baseOid: 'base-1',
  compareRef: 'feature',
  headOid: 'head-1',
  mergeBase: 'merge-1',
  changedFiles: 1,
  status: 'ready'
}

describe('buildActiveOpenFileSignature', () => {
  it('matches only the current branch comparison, keeping path separators intact', () => {
    const path = 'src/a::b.ts'
    const signature = buildActiveOpenFileSignature(
      'branch',
      path,
      toBranchCompareSnapshot(branchSummary),
      branchSummary
    )
    expect(
      buildActiveOpenRowKeys(signature, new Set([`branch::${path}`, `unstaged::${path}`]))
    ).toEqual(new Set([`branch::${path}`]))
    expect(buildActiveOpenRowKeys(signature, new Set([`unstaged::${path}`])).size).toBe(0)
  })

  it.each(['baseRef', 'baseOid', 'headOid', 'mergeBase'] as const)(
    'does not match an older branch tab when the published %s changes',
    (field) => {
      expect(
        buildActiveOpenFileSignature(
          'branch',
          'src/file.ts',
          toBranchCompareSnapshot(branchSummary),
          { ...branchSummary, [field]: 'different' }
        )
      ).toBeNull()
    }
  )

  it('does not claim a branch row without its snapshot or published summary', () => {
    expect(
      buildActiveOpenFileSignature('branch', 'src/file.ts', undefined, branchSummary)
    ).toBeNull()
    expect(
      buildActiveOpenFileSignature(
        'branch',
        'src/file.ts',
        toBranchCompareSnapshot(branchSummary),
        null
      )
    ).toBeNull()
  })

  it('encodes the diff source and relative path', () => {
    expect(buildActiveOpenFileSignature('staged', 'src/file.ts')).toBe('staged::src/file.ts')
    expect(buildActiveOpenFileSignature('unstaged', 'src/file.ts')).toBe('unstaged::src/file.ts')
  })

  it('falls back to the edit source when the tab has no diff source', () => {
    expect(buildActiveOpenFileSignature(undefined, 'docs/readme.md')).toBe('edit::docs/readme.md')
  })

  it('keeps separators that appear inside the path intact', () => {
    const signature = buildActiveOpenFileSignature('unstaged', 'src/a::b.ts')
    expect(buildActiveOpenRowKeys(signature)).toEqual(
      new Set(['unstaged::src/a::b.ts', 'untracked::src/a::b.ts'])
    )
  })
})

describe('buildActiveOpenRowKeys', () => {
  it('matches only the staged row for a staged diff', () => {
    expect(buildActiveOpenRowKeys('staged::src/file.ts')).toEqual(new Set(['staged::src/file.ts']))
  })

  it('matches the working-tree rows for an unstaged diff', () => {
    expect(buildActiveOpenRowKeys('unstaged::src/file.ts')).toEqual(
      new Set(['unstaged::src/file.ts', 'untracked::src/file.ts'])
    )
  })

  it('treats an untracked file opened as an unstaged diff like the working tree', () => {
    expect(buildActiveOpenRowKeys('unstaged::docs/readme.md')).toEqual(
      new Set(['unstaged::docs/readme.md', 'untracked::docs/readme.md'])
    )
  })

  it('matches edit tabs to working-tree rows before staged-only fallback', () => {
    expect(buildActiveOpenRowKeys('edit::docs/readme.md')).toEqual(
      new Set(['unstaged::docs/readme.md', 'untracked::docs/readme.md'])
    )
    expect(
      buildActiveOpenRowKeys(
        'edit::docs/readme.md',
        new Set(['staged::docs/readme.md', 'unstaged::docs/readme.md'])
      )
    ).toEqual(new Set(['unstaged::docs/readme.md']))
    expect(
      buildActiveOpenRowKeys('edit::docs/readme.md', new Set(['staged::docs/readme.md']))
    ).toEqual(new Set(['staged::docs/readme.md']))
  })

  it('does not match compare or combined diff tabs to pending rows', () => {
    expect(
      buildActiveOpenRowKeys('branch::src/file.ts', new Set(['unstaged::src/file.ts'])).size
    ).toBe(0)
    expect(buildActiveOpenRowKeys('commit::src/file.ts').size).toBe(0)
    expect(buildActiveOpenRowKeys('combined-uncommitted::src/file.ts').size).toBe(0)
    expect(buildActiveOpenRowKeys('combined-branch::src/file.ts').size).toBe(0)
    expect(buildActiveOpenRowKeys('combined-commit::src/file.ts').size).toBe(0)
  })

  it('returns an empty set when there is no active open file', () => {
    expect(buildActiveOpenRowKeys(null).size).toBe(0)
  })

  it('returns an empty set for a malformed signature', () => {
    expect(buildActiveOpenRowKeys('no-separator').size).toBe(0)
    expect(buildActiveOpenRowKeys('staged::').size).toBe(0)
  })
})
