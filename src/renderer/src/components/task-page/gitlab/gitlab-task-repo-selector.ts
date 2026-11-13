import type { Repo } from '../../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { GitLabDialogRepoSelector } from '../../gitlab-item-dialog/gitlab-item-dialog-types'
import { getTaskPageRepoSourceContext } from '../../../lib/work-items/task-repo-source-context'

export function gitLabTaskRepoSelector(repo: Repo): GitLabDialogRepoSelector {
  return {
    repoPath: repo.path,
    repoId: repo.id,
    sourceContext: getTaskPageRepoSourceContext(repo, 'gitlab'),
    repoOwnerExecutionHostId: getRepoExecutionHostId(repo)
  }
}
