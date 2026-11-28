import type { GiteaApi } from '../../../../preload/api/gitea/gitea-api'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import {
  forgeCredentialTarget,
  type ForgeRepoSelector
} from '../source-control/forge/forge-credential-target'
import { createRuntimeGiteaApi } from './runtime-gitea-api'

const GITEA_RPC_TIMEOUT_MS = 30_000

// A task source names the repo by its id on the server that published it.
function withSourceRepo(params: unknown, sourceRepoId: string | null): unknown {
  return sourceRepoId && params && typeof params === 'object' && 'repo' in params
    ? { ...params, repo: `id:${sourceRepoId}` }
    : params
}

/** The `gitea` API on the machine that holds the repo and its Gitea credentials. */
export function giteaApiFor(selector: ForgeRepoSelector): GiteaApi {
  let target: ReturnType<typeof forgeCredentialTarget>
  try {
    target = forgeCredentialTarget(selector)
  } catch (error) {
    // Callers chain `.then`/`await`; an unknown owner must reject, not throw synchronously.
    return createRuntimeGiteaApi(() => Promise.reject(error))
  }
  if (target.kind !== 'environment') {
    return window.api.gitea
  }
  const sourceRepoId = selector.sourceContext?.repoId?.trim() || null
  return createRuntimeGiteaApi((method, params) =>
    callRuntimeRpc(
      { kind: 'environment', environmentId: target.environmentId },
      method,
      withSourceRepo(params, sourceRepoId),
      {
        timeoutMs: GITEA_RPC_TIMEOUT_MS
      }
    )
  )
}
