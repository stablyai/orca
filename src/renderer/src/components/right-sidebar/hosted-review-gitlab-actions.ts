import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import {
  GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY,
  GITLAB_READY_FOR_REVIEW_UPDATE_REQUIRED_MESSAGE
} from '../../../../shared/protocol-version'
import type { Repo } from '../../../../shared/repo-types'
import { assertRuntimeEnvironmentCapability, callRuntimeRpc } from '@/runtime/runtime-rpc-client'

export async function markGitLabHostedReviewReadyForReview(args: {
  repo: Repo
  mrNumber: number
}): Promise<Awaited<ReturnType<typeof window.api.gl.updateMR>>> {
  const host = parseExecutionHostId(getRepoExecutionHostId(args.repo))
  if (host?.kind === 'runtime') {
    await assertRuntimeEnvironmentCapability(
      host.environmentId,
      GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY,
      GITLAB_READY_FOR_REVIEW_UPDATE_REQUIRED_MESSAGE
    )
    return callRuntimeRpc<Awaited<ReturnType<typeof window.api.gl.updateMR>>>(
      { kind: 'environment', environmentId: host.environmentId },
      'gitlab.updateMR',
      {
        repo: args.repo.id,
        iid: args.mrNumber,
        updates: { readyForReview: true }
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gl.updateMR({
    repoPath: args.repo.path,
    repoId: args.repo.id,
    iid: args.mrNumber,
    updates: { readyForReview: true }
  })
}
