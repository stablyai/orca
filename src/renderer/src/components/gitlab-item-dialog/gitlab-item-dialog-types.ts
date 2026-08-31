import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

export type GitLabItemDialogProps = {
  item: GitLabWorkItem | null
  repoPath: string | null
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  onClose: () => void
  onCreateWorkspace?: (item: GitLabWorkItem) => void
}

export type GitLabDialogRepoSelector = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}
