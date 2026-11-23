import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  forgeCredentialTarget,
  forgeOwnerHostIdForWorkspace
} from '@/runtime/source-control/forge/forge-credential-target'
import type {
  AzureDevOpsPrCheck,
  AzureDevOpsPrDetail,
  AzureDevOpsPrThread
} from '../../../../../../shared/azure-devops/azure-devops-pr-review-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

const AZURE_DEVOPS_REVIEW_TIMEOUT_MS = 30_000

export type AzureDevOpsReviewSnapshot = {
  detail: AzureDevOpsPrDetail | null
  checks: AzureDevOpsPrCheck[]
  threads: AzureDevOpsPrThread[]
}

/** One read of everything the Checks pane shows for an Azure DevOps PR, from the repo's owning host. */
export async function fetchAzureDevOpsReviewSnapshot(
  repo: Repo,
  worktree: Worktree | null,
  id: number
): Promise<AzureDevOpsReviewSnapshot> {
  const target = forgeCredentialTarget({
    repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(repo, worktree)
  })
  const params = { repo: `id:${repo.id}`, id }
  const options = { timeoutMs: AZURE_DEVOPS_REVIEW_TIMEOUT_MS }
  const [detail, checks, threads] = await Promise.all([
    callRuntimeRpc<AzureDevOpsPrDetail | null>(target, 'azureDevOps.pr', params, options),
    callRuntimeRpc<AzureDevOpsPrCheck[]>(target, 'azureDevOps.prChecks', params, options),
    callRuntimeRpc<AzureDevOpsPrThread[]>(target, 'azureDevOps.prThreads', params, options)
  ])
  return { detail, checks, threads }
}
