import { isWebClientLocation } from '@/lib/web-client-location'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { RepositoryAddScriptNotSentError } from '../../../shared/repository-add-script-errors'
import { repositoryAddScriptEnvironmentIdForHost } from '../../../shared/repository-add-script-route'
import type {
  RepositoryAddScriptDecision,
  RepositoryAddScriptDecisionResult,
  RepositoryAddScriptIdentity,
  RepositoryAddScriptOutcome
} from '../../../shared/repository-add-script-types'
import {
  decideRuntimeRepositoryAddScript,
  getRuntimeRepositoryAddScriptOutcome
} from './runtime-repository-add-script'

/** The token names a host this renderer cannot reach; never fall back to this computer. */
export class RepositoryAddScriptRouteError extends RepositoryAddScriptNotSentError {
  constructor(hostId: ExecutionHostId) {
    super(`This repository add script belongs to a different host (${hostId}).`)
    this.name = 'RepositoryAddScriptRouteError'
  }
}

function runtimeTarget(hostId: ExecutionHostId): { kind: 'environment'; environmentId: string } {
  const environmentId = repositoryAddScriptEnvironmentIdForHost(hostId)
  if (!environmentId) {
    throw new RepositoryAddScriptRouteError(hostId)
  }
  return { kind: 'environment', environmentId }
}

/**
 * Sends the decision once over the transport that owns the offered host. The web preload already
 * routes by alias, desktop IPC only serves this app's runtime, and a paired server needs its
 * dedicated helper; an alias neither transport owns is refused rather than re-routed.
 */
export async function decideRepositoryAddScript(
  decision: RepositoryAddScriptDecision
): Promise<RepositoryAddScriptDecisionResult> {
  if (isWebClientLocation() || decision.hostId === LOCAL_EXECUTION_HOST_ID) {
    return window.api.repos.decideAddScript(decision)
  }
  return decideRuntimeRepositoryAddScript(runtimeTarget(decision.hostId), decision)
}

/** Reads an outcome for exactly the identity the offer named; null when that host has no record. */
export async function getRepositoryAddScriptOutcome(
  identity: RepositoryAddScriptIdentity
): Promise<RepositoryAddScriptOutcome | null> {
  if (isWebClientLocation() || identity.hostId === LOCAL_EXECUTION_HOST_ID) {
    return window.api.repos.getAddScriptOutcome(identity)
  }
  return getRuntimeRepositoryAddScriptOutcome(runtimeTarget(identity.hostId), identity)
}
