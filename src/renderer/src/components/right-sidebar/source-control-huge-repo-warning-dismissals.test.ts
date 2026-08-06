import { afterEach, describe, expect, it } from 'vitest'
import {
  HUGE_REPO_WARNING_DISMISSAL_MAX_WORKTREES,
  beginHugeRepoWarningProbe,
  clearHugeRepoWarningDismissalsForTests,
  forgetHugeRepoWarningDismissalsForWorktrees,
  getHugeRepoWarningDismissalCountForTests,
  getHugeRepoWarningStateCountForTests,
  hasDismissedHugeRepoWarning,
  markHugeRepoWarningDismissed
} from '@/lib/source-control-huge-repo-warning-dismissals'

function worktree(id: string, instanceId: string = `${id}-instance`) {
  return { id, instanceId }
}

function probe(id: string, instanceId: string = `${id}-instance`) {
  return beginHugeRepoWarningProbe(worktree(id, instanceId))
}

describe('source-control huge repo warning dismissals', () => {
  afterEach(() => {
    clearHugeRepoWarningDismissalsForTests()
  })

  it('stays capped through prolonged churn while retaining a reused entry', () => {
    const retainedProbe = probe('keep')
    expect(markHugeRepoWarningDismissed(retainedProbe)).toBe(true)

    const churnCount = HUGE_REPO_WARNING_DISMISSAL_MAX_WORKTREES * 8
    for (let i = 0; i < churnCount; i += 1) {
      expect(markHugeRepoWarningDismissed(probe(`worktree-${i}`))).toBe(true)
      expect(hasDismissedHugeRepoWarning(retainedProbe)).toBe(true)
      if (i % HUGE_REPO_WARNING_DISMISSAL_MAX_WORKTREES === 0) {
        expect(getHugeRepoWarningStateCountForTests()).toBeLessThanOrEqual(
          HUGE_REPO_WARNING_DISMISSAL_MAX_WORKTREES
        )
      }
    }

    expect(getHugeRepoWarningStateCountForTests()).toBe(HUGE_REPO_WARNING_DISMISSAL_MAX_WORKTREES)
    expect(hasDismissedHugeRepoWarning(retainedProbe)).toBe(true)
    expect(hasDismissedHugeRepoWarning(probe('worktree-0'))).toBe(false)
    expect(hasDismissedHugeRepoWarning(probe(`worktree-${churnCount - 1}`))).toBe(true)
  })

  it('does not count duplicate dismissals as new worktree entries', () => {
    const repeatedProbe = probe('worktree-a')
    expect(markHugeRepoWarningDismissed(repeatedProbe)).toBe(true)
    expect(markHugeRepoWarningDismissed(repeatedProbe)).toBe(true)

    expect(getHugeRepoWarningDismissalCountForTests()).toBe(1)
    expect(hasDismissedHugeRepoWarning(repeatedProbe)).toBe(true)
  })

  it('preserves visibility toggles but clears an authoritatively removed path', () => {
    const originalWorktree = worktree('repo::/reused-path', 'persisted-instance')
    const originalProbe = beginHugeRepoWarningProbe(originalWorktree)
    expect(markHugeRepoWarningDismissed(originalProbe)).toBe(true)

    // Why: visibility filters can temporarily hide a still-live external
    // worktree, while an authoritative missing scan proves its lifecycle ended.
    forgetHugeRepoWarningDismissalsForWorktrees([])
    expect(hasDismissedHugeRepoWarning(beginHugeRepoWarningProbe({ ...originalWorktree }))).toBe(
      true
    )

    forgetHugeRepoWarningDismissalsForWorktrees([originalWorktree.id])

    // External recreation can reuse persisted metadata and instanceId.
    expect(hasDismissedHugeRepoWarning(beginHugeRepoWarningProbe({ ...originalWorktree }))).toBe(
      false
    )
    expect(getHugeRepoWarningDismissalCountForTests()).toBe(0)
  })

  it('rejects a late probe completion after authoritative removal', () => {
    const deferredProbe = probe('repo::/removed', 'persisted-instance')

    forgetHugeRepoWarningDismissalsForWorktrees([deferredProbe.worktreeId])
    const replacementProbe = probe('repo::/removed', 'persisted-instance')

    expect(markHugeRepoWarningDismissed(deferredProbe)).toBe(false)
    expect(hasDismissedHugeRepoWarning(replacementProbe)).toBe(false)
  })
})
