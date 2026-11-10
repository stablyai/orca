import type { RuntimeCapability } from '../../../../shared/protocol-version'
import {
  createRuntimeGitLabApi,
  RuntimeCapabilityMissingError,
  type GitLabApi
} from './runtime-gitlab-api'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import {
  runtimeEnvironmentCapabilityProof,
  runtimeEnvironmentSupportsCapability,
  type RuntimeCapabilityProof
} from '../rpc/compatibility/runtime-capability-proof'
import { captureRuntimeEnvironmentRequestRevision } from '../rpc/environment-revisions/runtime-environment-revision'
import {
  forgeCredentialTarget,
  type ForgeRepoSelector
} from '../source-control/forge/forge-credential-target'

// Why: job logs outlive main's 60s `glab` timeout so its classified error reaches the caller.
export const JOB_TRACE_TIMEOUT_MS = 65_000
const GITLAB_RPC_TIMEOUT_MS = 30_000

// Why: a task source names the repo by its id on the server that published it.
function withSourceRepo(params: unknown, sourceRepoId: string | null): unknown {
  return sourceRepoId && params && typeof params === 'object' && 'repo' in params
    ? { ...params, repo: `id:${sourceRepoId}` }
    : params
}

/** Capability proofs shared by one caller-owned batch (one Tasks refresh); never kept past it. */
export type GitLabCapabilityChecks = Map<string, Promise<RuntimeCapabilityProof>>

function capabilityProof(
  environmentId: string,
  capability: RuntimeCapability,
  checks: GitLabCapabilityChecks | undefined
): Promise<RuntimeCapabilityProof> {
  // Keyed by pairing so a re-paired environment never reuses the previous pairing's answer.
  const pairing = captureRuntimeEnvironmentRequestRevision(environmentId) ?? ''
  const key = `${environmentId}\0${pairing}\0${capability}`
  const existing = checks?.get(key)
  if (existing) {
    return existing
  }
  const proof = runtimeEnvironmentCapabilityProof(environmentId, capability)
  checks?.set(key, proof)
  return proof
}

function runtimeGitLabApi(
  environmentId: string,
  sourceRepoId: string | null,
  capabilityChecks: GitLabCapabilityChecks | undefined
): GitLabApi {
  const target = { kind: 'environment', environmentId } as const
  return createRuntimeGitLabApi({
    call: async (method, params, options) => {
      const timeoutMs = method === 'gitlab.jobTrace' ? JOB_TRACE_TIMEOUT_MS : GITLAB_RPC_TIMEOUT_MS
      if (!options?.requiredCapability) {
        return callRuntimeRpc(target, method, withSourceRepo(params, sourceRepoId), { timeoutMs })
      }
      const proof = await capabilityProof(
        environmentId,
        options.requiredCapability,
        capabilityChecks
      )
      if (!proof.supported) {
        throw new RuntimeCapabilityMissingError()
      }
      // Served by the runtime and pairing that answered, never one that replaced them meanwhile.
      return callRuntimeRpc(target, method, withSourceRepo(params, sourceRepoId), {
        timeoutMs,
        expectedEnvironmentPairingRevision: proof.pairingRevision,
        expectedEnvironmentRuntimeId: proof.runtimeId
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
