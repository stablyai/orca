import type { GitInspectionApi } from '../../../../../preload/api/source-control/git-inspection-api'
import type { GitStatusResult } from '../../../../../shared/git/status/git-status-types'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { GIT_SUBMODULE_WORKING_TREE_STATUS_RUNTIME_CAPABILITY } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import { RuntimeCapabilityMissingError } from '@/runtime/repository-gitlab/runtime-gitlab-api'
import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '../../../runtime/rpc/targets/runtime-worktree-selector'
import { resolveRuntimeWorktreeByPath } from '../workspaces/web-runtime-worktree-catalog'
import { callEnvironmentEnvelope, callRuntimeResult } from '../../runtime/client/web-runtime-calls'
import { requireActiveEnvironment } from '../../runtime/client/web-runtime-session'

// Why: a "no" may change when the host upgrades within the same pairing, so it is asked again later.
const UNSUPPORTED_ANSWER_TTL_MS = 60_000

// Explorer polls read submodules often; a "yes" is kept for the pairing, a "no" only briefly.
const answers = new Map<string, { supported: Promise<boolean>; askedAt: number }>()

function hostServesSubmoduleWorkingTree(
  environmentId: string,
  pairingRevision: number
): Promise<boolean> {
  const key = `${environmentId}\0${pairingRevision}`
  const cached = answers.get(key)
  if (cached) {
    return cached.supported.then((supported) => {
      if (supported || Date.now() - cached.askedAt < UNSUPPORTED_ANSWER_TTL_MS) {
        return supported
      }
      answers.delete(key)
      return hostServesSubmoduleWorkingTree(environmentId, pairingRevision)
    })
  }
  const supported = callEnvironmentEnvelope<RuntimeStatus>(
    environmentId,
    'status.get',
    undefined,
    15_000,
    pairingRevision
  )
    .then(unwrapRuntimeRpcResult)
    .then(
      (status) =>
        status.capabilities?.includes(GIT_SUBMODULE_WORKING_TREE_STATUS_RUNTIME_CAPABILITY) === true
    )
  answers.set(key, { supported, askedAt: Date.now() })
  void supported.catch(() => answers.delete(key))
  return supported
}

/** Paired web clients read submodule status on their host; the working-tree option needs a newer host. */
export const webGitSubmoduleStatus: GitInspectionApi['submoduleStatus'] = async ({
  worktreePath,
  submodulePath,
  area,
  workingTreeOnly
}) => {
  if (!workingTreeOnly) {
    const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
    return callRuntimeResult<GitStatusResult>('git.submoduleStatus', {
      worktree: toRuntimeWorktreeSelector(worktree.id),
      submodulePath,
      area
    })
  }
  // Pinned to the pairing that passed the check, so a host switch mid-read cannot skip it.
  const environment = requireActiveEnvironment()
  const pairingRevision = environment.pairingRevision ?? environment.createdAt
  if (!(await hostServesSubmoduleWorkingTree(environment.id, pairingRevision))) {
    throw new RuntimeCapabilityMissingError()
  }
  const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
  return unwrapRuntimeRpcResult(
    await callEnvironmentEnvelope<GitStatusResult>(
      environment.id,
      'git.submoduleStatus',
      {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        submodulePath,
        area,
        workingTreeOnly: true
      },
      undefined,
      pairingRevision
    )
  )
}
