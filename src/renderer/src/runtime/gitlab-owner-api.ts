import { createRuntimeGitLabApi, type GitLabApi } from './runtime-gitlab-api'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { forgeCredentialTarget, type ForgeRepoSelector } from './forge-credential-target'

// Why: job logs outlive main's 60s `glab` timeout so its classified error reaches the caller.
export const JOB_TRACE_TIMEOUT_MS = 65_000
const GITLAB_RPC_TIMEOUT_MS = 30_000

// Why: a task source names the repo by its id on the server that published it.
function withSourceRepo(params: unknown, sourceRepoId: string | null): unknown {
  return sourceRepoId && params && typeof params === 'object' && 'repo' in params
    ? { ...params, repo: `id:${sourceRepoId}` }
    : params
}

function runtimeGitLabApi(environmentId: string, sourceRepoId: string | null): GitLabApi {
  const target = { kind: 'environment', environmentId } as const
  return createRuntimeGitLabApi({
    call: (method, params) =>
      callRuntimeRpc(target, method, withSourceRepo(params, sourceRepoId), {
        timeoutMs: method === 'gitlab.jobTrace' ? JOB_TRACE_TIMEOUT_MS : GITLAB_RPC_TIMEOUT_MS
      }),
    supportsCapability: (capability) =>
      runtimeEnvironmentSupportsCapability(environmentId, capability)
  })
}

/** The `gl` API on the machine that holds the repo's GitLab credentials. */
export function gitLabApiFor(selector: ForgeRepoSelector): GitLabApi {
  let target: ReturnType<typeof forgeCredentialTarget>
  try {
    target = forgeCredentialTarget(selector)
  } catch (error) {
    // Why: callers chain `.then`/`await`; an unknown owner must reject, not throw synchronously.
    return createRuntimeGitLabApi({
      call: () => Promise.reject(error),
      supportsCapability: () => Promise.resolve(false)
    })
  }
  return target.kind === 'environment'
    ? runtimeGitLabApi(target.environmentId, selector.sourceContext?.repoId?.trim() || null)
    : window.api.gl
}
