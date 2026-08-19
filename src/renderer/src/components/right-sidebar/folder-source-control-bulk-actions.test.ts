import { describe, expect, it } from 'vitest'
import {
  bulkDiscardRuntimeGitPaths,
  bulkStageRuntimeGitPaths,
  bulkUnstageRuntimeGitPaths
} from '@/runtime/runtime-git-client'
import type { GitStatusEntry } from '../../../../shared/types'
import { resolveFolderBulkPaths } from './folder-source-control-bulk-actions'

/** Builds a GitStatusEntry fixture with the required path and area. */
function entry(
  overrides: Partial<GitStatusEntry> & { path: string; area: GitStatusEntry['area'] }
): GitStatusEntry {
  return {
    status: 'modified',
    ...overrides
  }
}

/** Tests folder bulk path resolution against shared eligibility rules. */
describe('resolveFolderBulkPaths', () => {
  const entries: GitStatusEntry[] = [
    entry({ path: 'unstaged.ts', area: 'unstaged' }),
    entry({
      path: 'conflict.ts',
      area: 'unstaged',
      conflictStatus: 'unresolved',
      conflictKind: 'both_modified'
    }),
    entry({
      path: 'resolved.ts',
      area: 'unstaged',
      conflictStatus: 'resolved_locally',
      conflictKind: 'both_modified'
    }),
    entry({ path: 'inner.ts', area: 'unstaged', submoduleRoot: 'vendor/lib' }),
    entry({
      path: 'submodule.ts',
      area: 'unstaged',
      submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: true }
    }),
    entry({ path: 'staged.ts', area: 'staged' })
  ]

  /** Stage-all paths should use the same conflict/submodule rules as rows. */
  it('uses shared stage eligibility for bulk stage paths', () => {
    expect(resolveFolderBulkPaths(entries, 'unstaged', bulkStageRuntimeGitPaths)).toEqual([
      'unstaged.ts',
      'resolved.ts'
    ])
  })

  /** Discard-all paths should exclude unresolved and submodule-internal rows. */
  it('uses shared discard eligibility for bulk discard paths', () => {
    expect(resolveFolderBulkPaths(entries, 'unstaged', bulkDiscardRuntimeGitPaths)).toEqual([
      'unstaged.ts'
    ])
  })

  /** Unstage-all should include every staged row. */
  it('uses shared unstage paths', () => {
    expect(resolveFolderBulkPaths(entries, 'staged', bulkUnstageRuntimeGitPaths)).toEqual([
      'staged.ts'
    ])
  })
})
