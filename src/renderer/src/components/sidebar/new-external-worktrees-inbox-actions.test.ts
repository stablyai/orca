import { describe, expect, it, vi } from 'vitest'

import type { Repo } from '../../../../shared/repo-types'
import {
  importNewExternalWorktreeInboxPaths,
  keepNewExternalWorktreeInboxHidden,
  suppressNewExternalWorktreeInbox
} from './new-external-worktrees-inbox-actions'

const projectId = 'repo-1'
const repo: Pick<Repo, 'externalWorktreeInboxBaselinePaths' | 'importedExternalWorktreePaths'> = {
  externalWorktreeInboxBaselinePaths: ['/scratch/old'],
  importedExternalWorktreePaths: []
}

describe('new external worktree inbox actions', () => {
  it('imports inbox worktrees into the sidebar allowlist', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const fetchWorktrees = vi.fn().mockResolvedValue(true)
    const setInboxState = vi.fn()

    await importNewExternalWorktreeInboxPaths({
      projectId,
      repo,
      worktreePaths: ['/scratch/new'],
      updateRepo,
      fetchWorktrees,
      setInboxState
    })

    expect(updateRepo).toHaveBeenCalledWith(projectId, {
      importedExternalWorktreePaths: ['/scratch/new'],
      externalWorktreeInboxBaselinePaths: ['/scratch/old', '/scratch/new']
    })
    expect(fetchWorktrees).toHaveBeenCalledWith(projectId, { requireAuthoritative: true })
    expect(setInboxState).toHaveBeenLastCalledWith(projectId, null)
  })

  it('rolls import path lists back with explicit empty arrays when refresh fails', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const fetchWorktrees = vi.fn().mockResolvedValue(false)
    const setInboxState = vi.fn()

    await importNewExternalWorktreeInboxPaths({
      projectId,
      repo: {},
      worktreePaths: ['/scratch/new'],
      updateRepo,
      fetchWorktrees,
      setInboxState
    })

    expect(updateRepo).toHaveBeenNthCalledWith(1, projectId, {
      importedExternalWorktreePaths: ['/scratch/new'],
      externalWorktreeInboxBaselinePaths: ['/scratch/new']
    })
    expect(updateRepo).toHaveBeenNthCalledWith(2, projectId, {
      importedExternalWorktreePaths: [],
      externalWorktreeInboxBaselinePaths: []
    })
  })

  it('extends the inbox baseline when keeping a batch hidden', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const setInboxState = vi.fn()

    const kept = await keepNewExternalWorktreeInboxHidden({
      projectId,
      repo: { ...repo, externalWorktreeVisibilityPromptDismissedAt: 123 },
      worktreePaths: ['/scratch/new'],
      updateRepo,
      setInboxState
    })

    expect(kept).toBe(true)
    expect(setInboxState).toHaveBeenNthCalledWith(1, projectId, { pending: true, error: null })
    expect(updateRepo).toHaveBeenCalledWith(projectId, {
      externalWorktreeInboxBaselinePaths: ['/scratch/old', '/scratch/new'],
      externalWorktreeVisibilityPromptDismissedAt: 123
    })
    expect(setInboxState).toHaveBeenLastCalledWith(projectId, null)
  })

  it('permanently suppresses the inbox and baselines the current batch', async () => {
    const updateRepo = vi.fn().mockResolvedValue(true)
    const setInboxState = vi.fn()

    const suppressed = await suppressNewExternalWorktreeInbox({
      projectId,
      repo,
      worktreePaths: ['/scratch/new'],
      updateRepo,
      setInboxState
    })

    expect(suppressed).toBe(true)
    expect(updateRepo).toHaveBeenCalledWith(projectId, {
      externalWorktreeDiscoverySuppressedAt: expect.any(Number),
      externalWorktreeInboxBaselinePaths: ['/scratch/old', '/scratch/new'],
      externalWorktreeVisibilityPromptDismissedAt: expect.any(Number)
    })
    expect(setInboxState).toHaveBeenLastCalledWith(projectId, null)
  })
})
