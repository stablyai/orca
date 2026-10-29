import { describe, expect, it, vi } from 'vitest'
import { openGitHubPRLinkModal } from './github-pr-link-modal'

const worktree = {
  repoId: 'repo-1',
  hostId: 'ssh:host' as const,
  displayName: 'Feature',
  linkedIssue: 7,
  comment: 'Remote workspace'
}

describe('openGitHubPRLinkModal', () => {
  it('preserves worktree owner routing and reports the saved PR', () => {
    const openModal = vi.fn()
    const afterLinked = vi.fn()

    openGitHubPRLinkModal({
      openModal,
      worktree,
      worktreeId: 'wt-1',
      currentPR: 42,
      afterLinked
    })

    expect(openModal).toHaveBeenCalledWith(
      'edit-meta',
      expect.objectContaining({
        worktreeId: 'wt-1',
        repoId: 'repo-1',
        executionHostId: 'ssh:host',
        reviewProvider: 'github',
        currentReview: 42,
        focus: 'pr'
      })
    )
    const data = openModal.mock.calls[0]?.[1] as {
      afterSave: (result: { updates?: { linkedPR?: unknown } }) => void
    }
    void data.afterSave({ updates: { linkedPR: 42 } })
    expect(afterLinked).toHaveBeenCalledWith(42)
  })
})
