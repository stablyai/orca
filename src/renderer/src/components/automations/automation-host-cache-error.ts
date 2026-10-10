/**
 * Classifies a failed host query by code rather than by copy, and decides
 * whether it may retry.
 *
 * The distinction that matters: a host that *proved* it cannot serve the
 * contract (old server, malformed payload, changed owner) must not burn the
 * retry budget, while an unreachable or slow host must.
 */

import { hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  stripAutomationOwnerConflictCode
} from '../../../../shared/automation-owner-conflict'
import {
  AutomationHostScopeUnsupportedError,
  AutomationListResponseError,
  matchAutomationOwnerConflict
} from './automation-scoped-list-client'
import type {
  AutomationHostQueryError,
  AutomationHostQueryErrorCode
} from './automation-host-cache-types'

export const AUTOMATION_HOST_RETRY_BASE_MS = 1_000
export const AUTOMATION_HOST_RETRY_CAP_MS = 30_000
export const AUTOMATION_HOST_MAX_ATTEMPTS = 3

const UNAVAILABLE_RPC_CODES = [
  'runtime_unavailable',
  'remote_runtime_unavailable',
  'relay_quota_exceeded'
]
const TIMEOUT_RPC_CODES = ['timeout', 'runtime_timeout']
const PERMISSION_RPC_CODES = ['permission_denied', 'unauthorized', 'forbidden']
const INCOMPATIBLE_RPC_CODES = ['capability_unsupported', 'legacy_read_only']
const INVALID_RPC_CODES = ['invalid_runtime_response', 'invalid_argument']

const RETRYABLE_CODES: ReadonlySet<AutomationHostQueryErrorCode> = new Set([
  'authority_unavailable',
  'timeout',
  'unknown'
])

const CONFLICT_QUERY_CODES: Record<string, AutomationHostQueryErrorCode> = {
  [AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged]: 'owner_changed',
  [AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved]: 'target_removed',
  [AUTOMATION_OWNER_CONFLICT_CODES.fencingRequired]: 'incompatible',
  [AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination]: 'invalid_response'
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return stripAutomationOwnerConflictCode(raw)
}

function codeOf(error: unknown): AutomationHostQueryErrorCode {
  if (error instanceof AutomationHostScopeUnsupportedError) {
    return 'incompatible'
  }
  if (error instanceof AutomationListResponseError) {
    return 'invalid_response'
  }
  const conflict = matchAutomationOwnerConflict(error)
  if (conflict) {
    return CONFLICT_QUERY_CODES[conflict] ?? 'unknown'
  }
  const matches = (codes: readonly string[]): boolean =>
    codes.some((code) => hasRuntimeRpcErrorCode(error, code))
  if (matches(UNAVAILABLE_RPC_CODES)) {
    return 'authority_unavailable'
  }
  if (matches(TIMEOUT_RPC_CODES)) {
    return 'timeout'
  }
  if (matches(PERMISSION_RPC_CODES)) {
    return 'permission_denied'
  }
  if (matches(INCOMPATIBLE_RPC_CODES)) {
    return 'incompatible'
  }
  if (matches(INVALID_RPC_CODES)) {
    return 'invalid_response'
  }
  return 'unknown'
}

export function classifyAutomationHostQueryError(
  error: unknown,
  options: { attempt: number; now: number; random?: () => number }
): AutomationHostQueryError {
  const code = codeOf(error)
  const retryable = RETRYABLE_CODES.has(code) && options.attempt < AUTOMATION_HOST_MAX_ATTEMPTS
  return {
    code,
    message: messageOf(error),
    retryable,
    retryAt: retryable
      ? options.now + automationHostRetryDelayMs(options.attempt, options.random)
      : null
  }
}

/** Full jitter: an authority that dropped every client must not get them back in lockstep. */
export function automationHostRetryDelayMs(
  attempt: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(
    AUTOMATION_HOST_RETRY_CAP_MS,
    AUTOMATION_HOST_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1)
  )
  return Math.round(random() * ceiling)
}
