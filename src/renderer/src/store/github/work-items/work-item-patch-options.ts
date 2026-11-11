import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'

export type GitHubPatchWorkItemOptions = {
  sourceContext?: TaskSourceContext | null
  ownerRepo?: GitHubOwnerRepo | null
}
