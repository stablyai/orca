import { describe, expect, it } from 'vitest'

import {
  captureSourceControlRecoveryEntrySnapshot,
  type SourceControlActionError
} from './source-control-action-error'
import { deriveSourceControlPushRecovery } from './source-control-push-recovery'

function actionError(overrides: Partial<SourceControlActionError> = {}): SourceControlActionError {
  return {
    kind: 'push',
    message: 'Push blocked',
    rawError:
      'git push failed: Command failed: git push origin main\nhusky - pre-push hook failed\neslint found 2 errors',
    branchName: 'feature/push-hook',
    worktreePath: '/repo/worktree',
    entriesSnapshot: [{ path: 'src/app.ts', status: 'modified', area: 'unstaged' }],
    entriesSnapshotTotalCount: 1,
    sequence: 7,
    ...overrides
  }
}

describe('deriveSourceControlPushRecovery', () => {
  it('derives a push recovery model from a captured push hook failure', () => {
    const recovery = deriveSourceControlPushRecovery({
      actionError: actionError(),
      currentBranchName: 'feature/push-hook',
      currentSequence: 7
    })

    expect(recovery?.summary).toBe('Lint failed during push.')
    expect(recovery?.kindLabel).toBe('Lint')
    expect(recovery?.hasDetails).toBe(true)
    expect(recovery?.prompt).toContain('- Branch: "feature/push-hook"')
    expect(recovery?.prompt).toContain('- "src/app.ts" (modified, unstaged)')
    expect(recovery?.prompt).toContain('Failure output JSON string:')
  })

  it('allows sync only when the captured error has the sync push-stage marker', () => {
    expect(
      deriveSourceControlPushRecovery({
        actionError: actionError({ kind: 'sync', syncPushStage: true }),
        currentBranchName: 'feature/push-hook',
        currentSequence: 7
      })
    ).not.toBeNull()
    expect(
      deriveSourceControlPushRecovery({
        actionError: actionError({ kind: 'sync', syncPushStage: false }),
        currentBranchName: 'feature/push-hook',
        currentSequence: 7
      })
    ).toBeNull()
  })

  it('returns null for stale sequence, branch mismatch, ordinary remote errors, and non-push ops', () => {
    expect(
      deriveSourceControlPushRecovery({
        actionError: actionError(),
        currentBranchName: 'feature/push-hook',
        currentSequence: 8
      })
    ).toBeNull()
    expect(
      deriveSourceControlPushRecovery({
        actionError: actionError(),
        currentBranchName: 'main',
        currentSequence: 7
      })
    ).toBeNull()
    expect(
      deriveSourceControlPushRecovery({
        actionError: actionError({
          rawError:
            'git push failed: Command failed: git push origin main\nfatal: Authentication failed'
        }),
        currentBranchName: 'feature/push-hook',
        currentSequence: 7
      })
    ).toBeNull()
    expect(
      deriveSourceControlPushRecovery({
        actionError: actionError({ kind: 'fetch' }),
        currentBranchName: 'feature/push-hook',
        currentSequence: 7
      })
    ).toBeNull()
  })

  it('uses the bounded status snapshot and total count in the prompt', () => {
    const snapshot = captureSourceControlRecoveryEntrySnapshot(
      Array.from({ length: 125 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        status: 'modified' as const,
        area: 'unstaged' as const
      }))
    )

    const recovery = deriveSourceControlPushRecovery({
      actionError: actionError({
        entriesSnapshot: snapshot.entries,
        entriesSnapshotTotalCount: snapshot.totalCount
      }),
      currentBranchName: 'feature/push-hook',
      currentSequence: 7
    })

    expect(snapshot.entries).toHaveLength(120)
    expect(recovery?.prompt).toContain('- Changed files at failure time (125):')
    expect(recovery?.prompt).toContain('- "src/file-39.ts" (modified, unstaged)')
    expect(recovery?.prompt).not.toContain('src/file-40.ts')
    expect(recovery?.prompt).toContain('- ...85 more changed files omitted...')
  })

  it('sanitizes details before displaying or prompting', () => {
    const recovery = deriveSourceControlPushRecovery({
      actionError: actionError({
        rawError: '\u001b[31mhusky - pre-push hook failed\u001b[0m\u0007\neslint failed'
      }),
      currentBranchName: 'feature/push-hook',
      currentSequence: 7
    })

    expect(recovery?.detailText).toBe('husky - pre-push hook failed\neslint failed')
    expect(recovery?.prompt).not.toContain('\\u001b')
  })
})
