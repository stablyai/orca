import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR,
  IMPORTED_WORKTREES_SHOW_ERROR,
  keepImportedWorktreesHiddenCard,
  showImportedWorktreesCard,
  type ImportedWorktreeCardActionState
} from './imported-worktrees-card-actions'

const projectId = 'repo-1'

describe('imported worktrees card actions', () => {
  const updateRepo = vi.fn()
  const fetchWorktrees = vi.fn()
  const setCardState =
    vi.fn<(projectId: string, state: ImportedWorktreeCardActionState | null) => void>()

  beforeEach(() => {
    vi.clearAllMocks()
    updateRepo.mockResolvedValue(true)
    fetchWorktrees.mockResolvedValue(true)
  })

  it('shows imported worktrees only after visibility update and refresh succeed', async () => {
    await showImportedWorktreesCard({ projectId, updateRepo, fetchWorktrees, setCardState })

    expect(updateRepo).toHaveBeenCalledWith(projectId, { externalWorktreeVisibility: 'show' })
    expect(fetchWorktrees).toHaveBeenCalledWith(projectId, { requireAuthoritative: true })
    expect(setCardState).toHaveBeenNthCalledWith(1, projectId, {
      pending: true,
      error: null,
      forceVisible: true
    })
    expect(setCardState).toHaveBeenLastCalledWith(projectId, null)
  })

  it('leaves the card visible when showing fails before refresh', async () => {
    updateRepo.mockResolvedValueOnce(false)

    await showImportedWorktreesCard({ projectId, updateRepo, fetchWorktrees, setCardState })

    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(setCardState).toHaveBeenLastCalledWith(projectId, {
      pending: false,
      error: IMPORTED_WORKTREES_SHOW_ERROR
    })
  })

  it('preserves force-visible state during a retry after rollback failure', async () => {
    updateRepo.mockResolvedValueOnce(false)

    await showImportedWorktreesCard({
      projectId,
      forceVisible: true,
      updateRepo,
      fetchWorktrees,
      setCardState
    })

    expect(fetchWorktrees).not.toHaveBeenCalled()
    expect(setCardState).toHaveBeenNthCalledWith(1, projectId, {
      pending: true,
      error: null,
      forceVisible: true
    })
    expect(setCardState).toHaveBeenLastCalledWith(projectId, {
      pending: false,
      error: IMPORTED_WORKTREES_SHOW_ERROR,
      forceVisible: true
    })
  })

  it('rolls visibility back and leaves an error when refresh fails after showing', async () => {
    fetchWorktrees.mockResolvedValueOnce(false)

    await showImportedWorktreesCard({ projectId, updateRepo, fetchWorktrees, setCardState })

    expect(updateRepo).toHaveBeenNthCalledWith(1, projectId, { externalWorktreeVisibility: 'show' })
    expect(updateRepo).toHaveBeenNthCalledWith(2, projectId, { externalWorktreeVisibility: 'hide' })
    expect(setCardState).toHaveBeenLastCalledWith(projectId, {
      pending: false,
      error: IMPORTED_WORKTREES_SHOW_ERROR
    })
  })

  it('keeps the card force-visible when rollback fails after a refresh failure', async () => {
    fetchWorktrees.mockResolvedValueOnce(false)
    updateRepo.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await showImportedWorktreesCard({ projectId, updateRepo, fetchWorktrees, setCardState })

    expect(updateRepo).toHaveBeenNthCalledWith(1, projectId, { externalWorktreeVisibility: 'show' })
    expect(updateRepo).toHaveBeenNthCalledWith(2, projectId, { externalWorktreeVisibility: 'hide' })
    expect(setCardState).toHaveBeenLastCalledWith(projectId, {
      pending: false,
      error: IMPORTED_WORKTREES_SHOW_ERROR,
      forceVisible: true
    })
  })

  it('dismisses the card when keep-hidden update succeeds', async () => {
    await keepImportedWorktreesHiddenCard({ projectId, updateRepo, setCardState })

    expect(updateRepo).toHaveBeenCalledWith(projectId, {
      externalWorktreeVisibilityPromptDismissedAt: expect.any(Number)
    })
    expect(setCardState).toHaveBeenLastCalledWith(projectId, null)
  })

  it('leaves the card visible when keep-hidden update fails', async () => {
    updateRepo.mockResolvedValueOnce(false)

    await keepImportedWorktreesHiddenCard({ projectId, updateRepo, setCardState })

    expect(setCardState).toHaveBeenLastCalledWith(projectId, {
      pending: false,
      error: IMPORTED_WORKTREES_KEEP_HIDDEN_ERROR
    })
  })
})
