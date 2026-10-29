import { describe, expect, it } from 'vitest'
import { createPrIntentOperationTarget } from './use-create-pr-intent-target'

// #32918: the same project at the same path locally and on an SSH host share one worktree id.
describe('createPrIntentOperationTarget', () => {
  it("refuses when the run's copy did not resolve, never using the local twin", () => {
    const target = createPrIntentOperationTarget(
      {
        repoId: 'repo1',
        worktreeId: 'repo1::/srv/ai-tools',
        worktreePath: '/srv/ai-tools',
        branch: 'feature',
        provider: 'github',
        pinnedCopy: null,
        startedAt: 0
      },
      undefined
    )

    expect(target).toMatchObject({ target: null, connectionId: undefined, ownerHostId: null })
  })
})
