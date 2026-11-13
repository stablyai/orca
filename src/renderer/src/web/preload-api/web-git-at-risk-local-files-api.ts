import type { PreloadApi } from '../../../../preload/api-types'
import type { WorktreeAtRiskLocalFiles } from '../../../../shared/worktree/removal/at-risk-local-files'
import { callAbortableRuntimeEnvironment } from '../../runtime/rpc/calls/abortable-runtime-environment-call'
import { unwrapRuntimeRpcResult } from '../../runtime/rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '../../runtime/rpc/targets/runtime-worktree-selector'
import { callRuntimeResult } from './web-runtime-calls'
import { requireActiveEnvironment, updateEnvironmentFromResponse } from './web-runtime-session'
import { resolveRuntimeWorktreeByPath } from './web-runtime-worktree-catalog'

type WebGitAtRiskLocalFilesApi = Pick<
  PreloadApi['git'],
  'atRiskLocalFiles' | 'cancelAtRiskLocalFiles'
>

const abortControllers = new Map<string, AbortController>()

async function callAbortableAtRiskLocalFiles(
  requestToken: string,
  worktreePath: string
): Promise<WorktreeAtRiskLocalFiles> {
  abortControllers.get(requestToken)?.abort()
  // Registered before the worktree lookup so a cancel that lands during it still stops the scan.
  const controller = new AbortController()
  abortControllers.set(requestToken, controller)
  try {
    const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
    const environment = requireActiveEnvironment()
    // Rejects without dispatching once aborted; unsubscribing closes the host request context.
    const response = await callAbortableRuntimeEnvironment(
      environment.id,
      'git.atRiskLocalFiles',
      { worktree: toRuntimeWorktreeSelector(worktree.id) },
      30_000,
      controller.signal
    )
    updateEnvironmentFromResponse(environment, response)
    // Typed unwrap keeps method_not_found, which the delete dialog treats as an older host.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: git.atRiskLocalFiles resolves WorktreeAtRiskLocalFiles; the callRuntimeResult path trusts the same contract.
    return unwrapRuntimeRpcResult(response) as WorktreeAtRiskLocalFiles
  } finally {
    if (abortControllers.get(requestToken) === controller) {
      abortControllers.delete(requestToken)
    }
  }
}

export function createWebGitAtRiskLocalFilesApi(): WebGitAtRiskLocalFilesApi {
  return {
    atRiskLocalFiles: async ({ worktreePath, requestToken }) => {
      if (requestToken) {
        return callAbortableAtRiskLocalFiles(requestToken, worktreePath)
      }
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.atRiskLocalFiles', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
    },
    cancelAtRiskLocalFiles: async ({ requestToken }) => {
      abortControllers.get(requestToken)?.abort()
    }
  }
}
