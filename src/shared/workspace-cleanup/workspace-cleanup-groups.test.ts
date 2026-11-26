import { describe, expect, it } from 'vitest'
import type { WorkspaceCleanupCandidate } from './workspace-cleanup'
import { getWorkspaceCleanupGroup } from './workspace-cleanup-groups'

const CHECKED_CLEAN = { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 }

function group(
  blockers: WorkspaceCleanupCandidate['blockers'],
  git: WorkspaceCleanupCandidate['git'] = CHECKED_CLEAN
): string {
  return getWorkspaceCleanupGroup({ blockers, git })
}

describe('getWorkspaceCleanupGroup', () => {
  it.each(['main-worktree', 'folder-repo', 'ssh-disconnected'] as const)(
    "puts a %s row in Can't delete",
    (blocker) => {
      expect(group([blocker])).toBe('cannot-delete')
    }
  )

  it.each(['dirty-files', 'ignored-files', 'unpushed-commits', 'unknown-base'] as const)(
    'puts a %s row in Has local files',
    (blocker) => {
      const git = { ...CHECKED_CLEAN, clean: blocker !== 'dirty-files' }
      expect(group([blocker], git)).toBe('local-files')
    }
  )

  it('puts a git status error in Has local files', () => {
    // The scan reports an unreadable status as unchecked git.
    expect(
      group(['git-status-error'], {
        clean: null,
        upstreamAhead: null,
        upstreamBehind: null,
        checkedAt: null
      })
    ).toBe('local-files')
  })

  it('treats unread git as local files so nothing unchecked reads as safe', () => {
    expect(
      group([], { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null })
    ).toBe('local-files')
  })

  it('keeps a clean, checked row in Nothing local', () => {
    expect(group([])).toBe('nothing-local')
  })

  it('lets an unqueueable row win over local-file risk', () => {
    expect(group(['main-worktree', 'dirty-files'], { ...CHECKED_CLEAN, clean: false })).toBe(
      'cannot-delete'
    )
  })
})
