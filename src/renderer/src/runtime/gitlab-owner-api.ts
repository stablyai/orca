import type { RuntimeCapability } from '../../../shared/protocol-version'
import {
  createRuntimeGitLabApi,
  RuntimeCapabilityMissingError,
  type GitLabApi
} from './runtime-gitlab-api'
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

/** Capability answers shared by one caller-owned batch (one Tasks refresh); never kept past it. */
export type GitLabCapabilityChecks = Map<string, Promise<boolean>>

function checkCapability(
  environmentId: string,
  capability: RuntimeCapability,
  checks: GitLabCapabilityChecks | undefined
): Promise<boolean> {
  const key = `${environmentId}\0${capability}`
  const existing = checks?.get(key)
  if (existing) {
    return existing
  }
  const check = runtimeEnvironmentSupportsCapability(environmentId, capability)
  checks?.set(key, check)
  return check
}

function runtimeGitLabApi(
  environmentId: string,
  sourceRepoId: string | null,
  capabilityChecks: GitLabCapabilityChecks | undefined
): GitLabApi {
  const target = { kind: 'environment', environmentId } as const
  return createRuntimeGitLabApi({
    call: async (method, params, options) => {
      if (
        options?.requiredCapability &&
        !(await checkCapability(environmentId, options.requiredCapability, capabilityChecks))
      ) {
        throw new RuntimeCapabilityMissingError()
      }
      return callRuntimeRpc(target, method, withSourceRepo(params, sourceRepoId), {
        timeoutMs: method === 'gitlab.jobTrace' ? JOB_TRACE_TIMEOUT_MS : GITLAB_RPC_TIMEOUT_MS
      })
    },
    supportsCapability: (capability) =>
      runtimeEnvironmentSupportsCapability(environmentId, capability)
  })
}

/** The `gl` API on the machine that holds the repo's GitLab credentials. */
export function gitLabApiFor(
  selector: ForgeRepoSelector,
  { capabilityChecks }: { capabilityChecks?: GitLabCapabilityChecks } = {}
): GitLabApi {
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
    ? runtimeGitLabApi(
        target.environmentId,
        selector.sourceContext?.repoId?.trim() || null,
        capabilityChecks
      )
    : window.api.gl
}
