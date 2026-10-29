import type { GitHubAssignableUser } from '../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type {
  GitHubWorkItemProjectOrigin,
  ItemDialogTab
} from '@/components/github/github-work-item-identity'

export type PullRequestPageProjectOrigin = GitHubWorkItemProjectOrigin

export type MentionOption = {
  login: string
  name?: string | null
  avatarUrl?: string
  source: string
}

export type MentionQuery = {
  atIndex: number
  query: string
}

export type PullRequestPageProps = {
  workItem: GitHubWorkItem | null
  repoPath: string | null
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  initialTab?: ItemDialogTab
  backLabel?: string
  onUse: (item: GitHubWorkItem) => void
  onReviewRequestsChange?: (
    itemKey: { id: string; repoId: string },
    reviewRequests: GitHubAssignableUser[]
  ) => void
  onClose: () => void
  /** Project-origin slug routing overrides repoPath for writes to the row’s repo. */
  projectOrigin?: PullRequestPageProjectOrigin
}
