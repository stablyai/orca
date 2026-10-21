import type { PreloadApi } from '../../../../preload/api-types'
import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { RepositoryAddScriptNotSentError } from '../../../../shared/repository-add-script-errors'
import { repositoryAddScriptEnvironmentIdForHost } from '../../../../shared/repository-add-script-route'
import type {
  RepositoryAddScriptDecisionResult,
  RepositoryAddScriptOutcome,
  RepositoryAddScriptRequest
} from '../../../../shared/repository-add-script-types'
import {
  REPOSITORY_ADD_SCRIPT_DECIDE_METHOD,
  REPOSITORY_ADD_SCRIPT_DECIDE_MIN_TIMEOUT_MS,
  REPOSITORY_ADD_SCRIPT_OUTCOME_METHOD
} from '../../../../shared/repository-add-script-wire'
import { REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY } from '../../../../shared/repository-add-script-runtime-capabilities'
import { callEnvironmentEnvelope, getRemoteRuntimeStatus } from './web-runtime-calls'
import {
  assertActiveEnvironment,
  requireActiveEnvironment,
  resolveEnvironment
} from './web-runtime-session'

type WebReposApi = NonNullable<PreloadApi['repos']>

const UNSUPPORTED_MESSAGE = 'Update this Orca server to run a repository add script from here.'
const WRONG_ROUTE_MESSAGE = 'This repository add script belongs to a different host.'

async function activeHostSupportsAddScript(environmentId: string): Promise<boolean> {
  const status = await getRemoteRuntimeStatus()
  assertActiveEnvironment(environmentId)
  return status.capabilities?.includes(REPOSITORY_ADD_SCRIPT_RUNTIME_CAPABILITY) === true
}

/**
 * The opt-in to send with a registration, or undefined when the registration must go out as it was
 * before: an unsupported host would ignore the field, and the request is never re-routed elsewhere.
 */
export async function resolveWebRepositoryAddScriptRequest(
  requested: RepositoryAddScriptRequest | undefined
): Promise<RepositoryAddScriptRequest | undefined> {
  if (!requested) {
    return undefined
  }
  const environment = requireActiveEnvironment()
  if (requested.hostId !== toRuntimeExecutionHostId(environment.id)) {
    throw new RepositoryAddScriptNotSentError(WRONG_ROUTE_MESSAGE)
  }
  try {
    return (await activeHostSupportsAddScript(environment.id)) ? requested : undefined
  } catch {
    // Why: the offer is optional, so an unprovable capability must not fail the registration.
    assertActiveEnvironment(environment.id)
    return undefined
  }
}

// The host named by the token's alias is the only one asked; a client with no such host fails.
async function callNamedHost<TResult>(
  hostId: ExecutionHostId,
  method: string,
  params: unknown,
  timeoutMs?: number
): Promise<TResult> {
  const environmentId = repositoryAddScriptEnvironmentIdForHost(hostId)
  if (!environmentId) {
    throw new RepositoryAddScriptNotSentError(WRONG_ROUTE_MESSAGE)
  }
  let environment: ReturnType<typeof resolveEnvironment>
  try {
    environment = resolveEnvironment(environmentId)
    // resolveEnvironment also takes `active` and the display name, which an alias must not.
    if (
      environment.id !== environmentId &&
      !environment.compatibleEnvironmentIds?.includes(environmentId)
    ) {
      throw new RepositoryAddScriptNotSentError(WRONG_ROUTE_MESSAGE)
    }
    if (!(await activeHostSupportsAddScript(environment.id))) {
      throw new RepositoryAddScriptNotSentError(UNSUPPORTED_MESSAGE)
    }
  } catch (error) {
    // Everything above runs before the request leaves this client, so its fate is certain.
    if (error instanceof RepositoryAddScriptNotSentError) {
      throw error
    }
    throw new RepositoryAddScriptNotSentError(
      error instanceof Error ? error.message : String(error)
    )
  }
  // Pinned to this pairing so a re-pair mid-request cannot answer for another server.
  const response = await callEnvironmentEnvelope<TResult>(
    environment.id,
    method,
    params,
    timeoutMs,
    environment.pairingRevision ?? environment.createdAt
  )
  if (!response.ok) {
    throw Object.assign(new Error(response.error.message), { code: response.error.code })
  }
  return response.result
}

export function createWebRepositoryAddScriptApi(): Pick<
  WebReposApi,
  'decideAddScript' | 'getAddScriptOutcome'
> {
  return {
    // The run answers when the script ends; a shorter deadline would report a live run as lost.
    decideAddScript: async (decision) =>
      (
        await callNamedHost<{ result: RepositoryAddScriptDecisionResult }>(
          decision.hostId,
          REPOSITORY_ADD_SCRIPT_DECIDE_METHOD,
          // Only the four identity fields travel, even if the caller passed a whole offer.
          {
            token: decision.token,
            hostId: decision.hostId,
            repoId: decision.repoId,
            decision: decision.decision
          },
          REPOSITORY_ADD_SCRIPT_DECIDE_MIN_TIMEOUT_MS
        )
      ).result,
    getAddScriptOutcome: async (identity) =>
      (
        await callNamedHost<{ outcome: RepositoryAddScriptOutcome | null }>(
          identity.hostId,
          REPOSITORY_ADD_SCRIPT_OUTCOME_METHOD,
          { token: identity.token, hostId: identity.hostId, repoId: identity.repoId }
        )
      ).outcome
  }
}
