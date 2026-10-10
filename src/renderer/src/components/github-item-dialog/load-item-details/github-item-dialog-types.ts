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

export type GitHubItemDialogEditSectionProps = {
  item: GitHubWorkItem
  repoPath: string | null
  repoId: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: GitHubItemDialogProjectOrigin | undefined
  localState: GitHubWorkItem['state']
  localLabels: string[]
  onStateChange: (state: GitHubWorkItem['state']) => void
  onLabelsChange: (labels: string[]) => void
  /** Why: lets the parent invalidate its details cache after a mutation, else a reopen within FRESH_MS paints pre-mutation data. */
  onMutated: () => void
  assignees: string[]
  onUse: (item: GitHubWorkItem) => void
  onOpenOrUse?: (item: GitHubWorkItem) => void
  attachedWorkspaceLabel?: string | null
  /** `horizontal`: compact pill strip for the non-issue drawer/header; `top-columns`: labeled columns above the issue page body. */
  layout?: 'horizontal' | 'top-columns'
}
