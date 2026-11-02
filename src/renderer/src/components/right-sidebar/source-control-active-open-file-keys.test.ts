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
})

describe('buildActiveOpenRowKeys', () => {
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
})
