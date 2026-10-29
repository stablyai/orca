// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { finishProjectAddWithDefaultCheckout } from './project-added-default-checkout'
import { useCompleteGitRepoAdd } from './use-complete-git-repo-add'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ worktreesByRepo: {} }) }
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('./project-added-default-checkout', () => ({
  finishProjectAddWithDefaultCheckout: vi.fn().mockResolvedValue(undefined)
}))

describe('useCompleteGitRepoAdd', () => {
  it('hands the picked folder to the checkout handoff so a linked checkout opens itself', async () => {
    const closeModal = vi.fn()
    const setHideDefaultBranchWorkspace = vi.fn()
    const { result } = renderHook(() =>
      useCompleteGitRepoAdd({ closeModal, setHideDefaultBranchWorkspace })
    )

    await result.current('repo-1', 'local_folder_picker', 'local', {
      selectedPath: '/projects/linked-feature'
    })

    expect(finishProjectAddWithDefaultCheckout).toHaveBeenCalledWith({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      selectedPath: '/projects/linked-feature',
      executionHostId: 'local',
      closeModal,
      setHideDefaultBranchWorkspace
    })
  })
})
