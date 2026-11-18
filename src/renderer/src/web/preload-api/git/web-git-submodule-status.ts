import type { GitInspectionApi } from '../../../../../preload/api/source-control/git-inspection-api'
import type { GitStatusResult } from '../../../../../shared/git/status/git-status-types'
import { RuntimeCapabilityMissingError } from '@/runtime/repository-gitlab/runtime-gitlab-api'
import { toRuntimeWorktreeSelector } from '../../../runtime/rpc/targets/runtime-worktree-selector'
import { resolveRuntimeWorktreeByPath } from '../workspaces/web-runtime-worktree-catalog'
import { GIT_SUBMODULE_WORKING_TREE_STATUS_RUNTIME_CAPABILITY } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import { callRuntimeResult, getRemoteRuntimeStatus } from '../../runtime/client/web-runtime-calls'
import { requireActiveEnvironment } from '../../runtime/client/web-runtime-session'

// Why: explorer polls read submodules often; ask the paired host once per pairing, not per read.
const answers = new Map<string, Promise<boolean>>()

/** Older hosts drop `workingTreeOnly` and would answer with committed-range rows. */
function webHostServesSubmoduleWorkingTree(): Promise<boolean> {
  const environment = requireActiveEnvironment()
  const key = `${environment.id}\0${environment.pairingRevision ?? environment.createdAt}`
  const existing = answers.get(key)
  if (existing) {
    return existing
  }
  const answer = getRemoteRuntimeStatus().then(
    (status) =>
      status.capabilities?.includes(GIT_SUBMODULE_WORKING_TREE_STATUS_RUNTIME_CAPABILITY) === true
  )
  answers.set(key, answer)
  void answer.catch(() => answers.delete(key))
  return answer
}

/** Paired web clients read submodule status on their host; the working-tree option needs a newer host. */
export const webGitSubmoduleStatus: GitInspectionApi['submoduleStatus'] = async ({
  worktreePath,
  submodulePath,
  area,
  workingTreeOnly
}) => {
  if (workingTreeOnly && !(await webHostServesSubmoduleWorkingTree())) {
    throw new RuntimeCapabilityMissingError()
  }
  const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
  return callRuntimeResult<GitStatusResult>('git.submoduleStatus', {
    worktree: toRuntimeWorktreeSelector(worktree.id),
    submodulePath,
    area,
    ...(workingTreeOnly ? { workingTreeOnly: true } : {})
  })
}
