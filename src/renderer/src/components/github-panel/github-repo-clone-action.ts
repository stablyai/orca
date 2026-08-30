import { useAppStore } from '@/store'
import type { GitHubAccountRepo } from '../../../../shared/github-account'
import { upsertAddedRepoWithProjectHostSetup } from '../sidebar/add-repo-store-upsert'
import { worktreeRefreshOptions } from '../sidebar/add-repo-runtime-owner'
import { finishProjectAddWithDefaultCheckout } from '../sidebar/project-added-default-checkout'

export type GitHubRepoCloneOutcome = { ok: true } | { ok: false; error: string }

// Clones a GitHub repo through the authenticated account IPC, then runs the
// same store upsert + worktree refresh + default-checkout reveal the Add
// Project dialog uses, so the new project lands in the sidebar identically.
export async function cloneGitHubRepoIntoProjects(
  item: GitHubAccountRepo,
  destination: string
): Promise<GitHubRepoCloneOutcome> {
  const result = await window.api.githubAuth.cloneRepo({
    fullName: item.fullName,
    cloneUrl: item.cloneUrl,
    isPrivate: item.isPrivate,
    destination
  })
  if (!result.ok) {
    return { ok: false, error: result.error }
  }
  const { repo: ownedRepo } = upsertAddedRepoWithProjectHostSetup(result.repo, {})
  await useAppStore.getState().fetchWorktrees(ownedRepo.id, worktreeRefreshOptions(null))
  // Why: reveal handles the no-worktree fallback itself, so a failed refresh
  // still finalizes the add instead of leaving the project half-visible.
  await finishProjectAddWithDefaultCheckout({
    repoId: ownedRepo.id,
    source: 'clone_url',
    closeModal: () => {},
    setHideDefaultBranchWorkspace: (value) =>
      useAppStore.getState().setHideDefaultBranchWorkspace(value)
  })
  return { ok: true }
}
