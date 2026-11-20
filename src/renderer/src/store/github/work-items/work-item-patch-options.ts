import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../../../shared/github/repositories/repository-identity'

export type GitHubPatchWorkItemOptions = {
  sourceContext?: TaskSourceContext | null
  ownerRepo?: GitHubOwnerRepo | null
}
