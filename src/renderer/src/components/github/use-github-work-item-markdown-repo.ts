import { useAppStore } from '@/store/index'
import { getWorkItemRepo, type WorkItemRepoRef } from '@/lib/work-items/work-item-repo-row'
import { isDefaultGitHubHost } from '../../../../shared/github/repositories/repository-identity-key'
import type { GitHubRepositoryIdentity } from '../../../../shared/github/repositories/repository-identity'

export function useGitHubWorkItemMarkdownRepo(
  repoRef: WorkItemRepoRef,
  itemRepo: GitHubRepositoryIdentity | null
): GitHubRepositoryIdentity | null {
  const defaultIssueRepository = useAppStore((state) =>
    itemRepo && isDefaultGitHubHost(itemRepo.host)
      ? getWorkItemRepo(state.repos, repoRef)?.defaultIssueRepository
      : null
  )
  return defaultIssueRepository ?? itemRepo
}
