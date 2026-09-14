import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type {
  GitHubWorkItemProjectOrigin,
  ItemDialogTab
} from '@/components/github/github-work-item-identity'

/** Re-exported so Project-view callers keep a stable import path. */
export type GitHubItemDialogProjectOrigin = GitHubWorkItemProjectOrigin

export type GitHubItemDialogProps = {
  workItem: GitHubWorkItem | null
  repoPath: string | null
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  initialTab?: ItemDialogTab
  backLabel?: string
  /** Called when the user clicks the primary CTA to start work from this item. */
  onUse: (item: GitHubWorkItem) => void
  onReviewRequestsChange?: (
    itemKey: { id: string; repoId: string },
    reviewRequests: GitHubAssignableUser[]
  ) => void
  onClose: () => void
  /** Optional Project-origin context; when set, edits route via slug-addressed IPCs against the row's repo (slug routing wins for writes). */
  projectOrigin?: GitHubItemDialogProjectOrigin
}
