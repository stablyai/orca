import { RepositoryAddScriptNotSentError } from '../../../shared/repository-add-script-errors'
import { repositoryAddScriptHostIdForTarget } from '../../../shared/repository-add-script-route'
import type {
  RepositoryAddScriptDecision,
  RepositoryAddScriptDecisionResult,
  RepositoryAddScriptIdentity,
  RepositoryAddScriptOutcome,
  RepositoryAddScriptRequest
} from '../../../shared/repository-add-script-types'
import {
  REPOSITORY_ADD_SCRIPT_DECIDE_METHOD,
  REPOSITORY_ADD_SCRIPT_DECIDE_MIN_TIMEOUT_MS,
  REPOSITORY_ADD_SCRIPT_OUTCOME_METHOD
} from '../../../shared/repository-add-script-wire'
import { REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY } from '../../../shared/repository-add-script-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'

/** The paired server predates the add-script methods; the caller shows "update the server". */
export class RuntimeRepositoryAddScriptUnsupportedError extends RepositoryAddScriptNotSentError {
  constructor() {
    super('Update this Orca server to run a repository add script from here.')
    this.name = 'RuntimeRepositoryAddScriptUnsupportedError'
  }
}

export class RuntimeRepositoryAddScriptRouteError extends RepositoryAddScriptNotSentError {
  constructor() {
    super('This repository add script belongs to a different host.')
    this.name = 'RuntimeRepositoryAddScriptRouteError'
  }
}

type RouteOptions = {
  signal?: AbortSignal
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
}

async function targetSupportsAddScript(target: RuntimeClientTarget): Promise<boolean> {
  // This app's own runtime is the same build as its renderer.
  return (
    target.kind === 'local' ||
    runtimeEnvironmentSupportsCapability(
      target.environmentId,
      REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY
    )
  )
}

/**
 * The opt-in to send with a registration on this target, or undefined when the registration must
 * go out as it was: an older server would silently ignore the field. Never re-routes to another host.
 */
export async function resolveRuntimeRepositoryAddScriptRequest(
  target: RuntimeClientTarget
): Promise<RepositoryAddScriptRequest | undefined> {
  try {
    return (await targetSupportsAddScript(target))
      ? { hostId: repositoryAddScriptHostIdForTarget(target) }
      : undefined
  } catch {
    // Why: the offer is optional, so an unprovable capability must not fail the registration.
    return undefined
  }
}

// Fixed to the target the offer came from; an identity naming another alias is refused unsent.
async function requireRoute(
  target: RuntimeClientTarget,
  identity: RepositoryAddScriptIdentity
): Promise<void> {
  try {
    if (identity.hostId !== repositoryAddScriptHostIdForTarget(target)) {
      throw new RuntimeRepositoryAddScriptRouteError()
    }
    if (!(await targetSupportsAddScript(target))) {
      throw new RuntimeRepositoryAddScriptUnsupportedError()
    }
  } catch (error) {
    if (error instanceof RepositoryAddScriptNotSentError) {
      throw error
    }
    // Why: the capability probe runs before any send, so a failed probe means nothing left this client.
    throw new RepositoryAddScriptNotSentError(
      error instanceof Error ? error.message : String(error)
    )
  }
}

/**
 * Sends the decision once. A timeout or disconnect leaves the run's fate unknown, so this never
 * resends: the caller reads the outcome for the same token instead.
 */
export async function decideRuntimeRepositoryAddScript(
  target: RuntimeClientTarget,
  decision: RepositoryAddScriptDecision,
  options: RouteOptions = {}
): Promise<RepositoryAddScriptDecisionResult> {
  await requireRoute(target, decision)
  const { result } = await callRuntimeRpc<{ result: RepositoryAddScriptDecisionResult }>(
    target,
    REPOSITORY_ADD_SCRIPT_DECIDE_METHOD,
    {
      token: decision.token,
      hostId: decision.hostId,
      repoId: decision.repoId,
      decision: decision.decision
    },
    { ...options, timeoutMs: REPOSITORY_ADD_SCRIPT_DECIDE_MIN_TIMEOUT_MS }
  )
  return result
}

export async function getRuntimeRepositoryAddScriptOutcome(
  target: RuntimeClientTarget,
  identity: RepositoryAddScriptIdentity,
  options: RouteOptions = {}
): Promise<RepositoryAddScriptOutcome | null> {
  await requireRoute(target, identity)
  const { outcome } = await callRuntimeRpc<{ outcome: RepositoryAddScriptOutcome | null }>(
    target,
    REPOSITORY_ADD_SCRIPT_OUTCOME_METHOD,
    { token: identity.token, hostId: identity.hostId, repoId: identity.repoId },
    options
  )
  return outcome
}
