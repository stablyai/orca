import { describe, expect, it } from 'vitest'

import {
  decideExternalWorktreeImport,
  decideExternalWorktreeUnimport,
  isVisibleWithoutExplicitImport
} from './external-worktree-import'
import type { Repo } from './repo-types'
import type { DetectedWorktree } from './worktree/types'

const SCRATCH_PATH = '/repo/.claude/worktrees/task'

function repo(
  importedExternalWorktreePaths?: string[]
): Pick<Repo, 'importedExternalWorktreePaths'> {
  return importedExternalWorktreePaths ? { importedExternalWorktreePaths } : {}
}

function worktree(
  overrides: Partial<Pick<DetectedWorktree, 'path' | 'ownership' | 'selectedCheckout'>> = {}
): Pick<DetectedWorktree, 'path' | 'ownership' | 'selectedCheckout'> {
  return {
    path: SCRATCH_PATH,
    ownership: 'agent-scratch',
    selectedCheckout: false,
    ...overrides
  }
}

describe('external worktree import decisions', () => {
  it('records the resolved path when a hidden worktree is not imported yet', () => {
    expect(decideExternalWorktreeImport({ repo: repo(), worktree: worktree() })).toEqual({
      outcome: 'imported',
      importedExternalWorktreePaths: [SCRATCH_PATH]
    })
  })

  it('keeps existing imports and appends the new path', () => {
    expect(
      decideExternalWorktreeImport({ repo: repo(['/repo/other']), worktree: worktree() })
    ).toEqual({
      outcome: 'imported',
      importedExternalWorktreePaths: ['/repo/other', SCRATCH_PATH]
    })
  })

  it('is idempotent, including for paths that differ only by trailing slash', () => {
    expect(
      decideExternalWorktreeImport({ repo: repo([SCRATCH_PATH]), worktree: worktree() })
    ).toEqual({ outcome: 'already-imported' })
    expect(
      decideExternalWorktreeImport({
        repo: repo([`${SCRATCH_PATH}/`]),
        worktree: worktree()
      })
    ).toEqual({ outcome: 'already-imported' })
  })

  it('refuses to record worktrees the sidebar shows regardless of the import list', () => {
    expect(
      decideExternalWorktreeImport({
        repo: repo(),
        worktree: worktree({ ownership: 'orca-managed' })
      })
    ).toEqual({ outcome: 'always-visible' })
    expect(
      decideExternalWorktreeImport({
        repo: repo(),
        worktree: worktree({ selectedCheckout: true, path: '/repo' })
      })
    ).toEqual({ outcome: 'always-visible' })
  })

  it('still records external worktrees that are only visible through the repo-wide setting', () => {
    // Why: the repo-wide toggle can be flipped back to hide; an explicit import
    // is what pins this worktree's visibility, so it is not a no-op.
    expect(
      decideExternalWorktreeImport({
        repo: repo(),
        worktree: worktree({ ownership: 'external' })
      })
    ).toEqual({ outcome: 'imported', importedExternalWorktreePaths: [SCRATCH_PATH] })
  })

  it('drops only the requested path on unimport', () => {
    expect(
      decideExternalWorktreeUnimport({
        repo: repo(['/repo/other', SCRATCH_PATH]),
        worktree: worktree()
      })
    ).toEqual({ outcome: 'unimported', importedExternalWorktreePaths: ['/repo/other'] })
  })

  it('reports a no-op unimport for a path that was never imported', () => {
    expect(
      decideExternalWorktreeUnimport({ repo: repo(['/repo/other']), worktree: worktree() })
    ).toEqual({ outcome: 'not-imported' })
  })

  it('treats the selected checkout and Orca-created worktrees as visible without an import', () => {
    expect(isVisibleWithoutExplicitImport(worktree({ selectedCheckout: true }))).toBe(true)
    expect(isVisibleWithoutExplicitImport(worktree({ ownership: 'orca-managed' }))).toBe(true)
    expect(isVisibleWithoutExplicitImport(worktree({ ownership: 'unknown-legacy' }))).toBe(false)
    expect(isVisibleWithoutExplicitImport(worktree())).toBe(false)
  })
})
