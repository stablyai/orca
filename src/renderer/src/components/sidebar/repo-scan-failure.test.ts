import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { makeDetectedResult } from '@/store/slices/worktrees-detected-listing-fixtures'
import { resolveRepoScanFailure } from './repo-scan-failure'

const repo: Repo = {
  id: 'repo-1',
  path: 'C:\\Users\\dev\\orca\\volume-control',
  displayName: 'volume-control',
  badgeColor: '#000',
  addedAt: 0
}

function failureFor(unavailableReason: string): ReturnType<typeof resolveRepoScanFailure> {
  return resolveRepoScanFailure(
    repo,
    makeDetectedResult(repo.id, [], {
      authoritative: false,
      source: 'metadata-fallback',
      unavailableReason,
      failureKind: 'unknown'
    })
  )
}

describe('resolveRepoScanFailure', () => {
  // Exact Git for Windows output when core.worktree was written from WSL.
  it('recognizes a WSL core.worktree path that Git for Windows cannot resolve', () => {
    expect(
      failureFor(
        "Command failed: git worktree list --porcelain -z\nfatal: Invalid path '/mnt': No such file or directory"
      )?.kind
    ).toBe('wsl-worktree-path')
    expect(
      failureFor("fatal: Invalid path '/mnt/c/Users/dev': No such file or directory")?.kind
    ).toBe('wsl-worktree-path')
  })

  it('keeps other invalid-path failures as reported by the host', () => {
    expect(failureFor("fatal: Invalid path '/mntdata/repo': No such file or directory")?.kind).toBe(
      'unknown'
    )
  })
})
