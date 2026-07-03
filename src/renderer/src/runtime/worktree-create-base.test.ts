import { describe, expect, it, vi } from 'vitest'
import { resolveWorktreeCreateBaseBranch } from './worktree-create-base'

describe('resolveWorktreeCreateBaseBranch', () => {
  it('uses an explicit Start-from selection before repo defaults', async () => {
    const loadDefaultBaseRef = vi.fn().mockResolvedValue('origin/main')

    await expect(
      resolveWorktreeCreateBaseBranch({
        explicitBaseBranch: 'origin/feature',
        repoWorktreeBaseRef: 'dev',
        loadDefaultBaseRef
      })
    ).resolves.toBe('origin/feature')

    expect(loadDefaultBaseRef).not.toHaveBeenCalled()
  })

  it('uses the pinned repo worktree base before resolving the git primary', async () => {
    const loadDefaultBaseRef = vi.fn().mockResolvedValue('origin/main')

    await expect(
      resolveWorktreeCreateBaseBranch({
        explicitBaseBranch: undefined,
        repoWorktreeBaseRef: ' dev ',
        loadDefaultBaseRef
      })
    ).resolves.toBe('dev')

    expect(loadDefaultBaseRef).not.toHaveBeenCalled()
  })

  it('falls back to the git primary when no explicit or pinned base exists', async () => {
    await expect(
      resolveWorktreeCreateBaseBranch({
        explicitBaseBranch: undefined,
        repoWorktreeBaseRef: undefined,
        loadDefaultBaseRef: vi.fn().mockResolvedValue('origin/main')
      })
    ).resolves.toBe('origin/main')
  })
})
