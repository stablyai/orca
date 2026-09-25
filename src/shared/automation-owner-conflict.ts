/**
 * The typed conflicts an authority returns when a request's captured owner no
 * longer matches its stored automation.
 *
 * These cross two transports that keep nothing but a string: Electron IPC
 * rewraps the message ("Error invoking remote method 'x': Error: …") and an
 * older runtime maps unknown error classes to `runtime_error`. So every message
 * ends with `: <code>`, the machine-token convention `hasRuntimeRpcErrorCode`
 * already matches, and callers strip the tail before display.
 */

import { hasRuntimeRpcErrorCode } from './runtime-rpc-error-code'

export const AUTOMATION_OWNER_CONFLICT_CODES = {
  /** The stored selector or its SSH generation differs from the captured one. */
  ownerChanged: 'automation_owner_changed',
  /** The record's SSH target is no longer registered, so nothing may execute on it. */
  targetRemoved: 'automation_target_removed',
  /** The caller omitted a precondition for a record that carries a fenceable SSH owner. */
  fencingRequired: 'automation_owner_fencing_required',
  /** The requested create/update destination does not resolve on this authority. */
  invalidDestination: 'automation_destination_invalid'
} as const

export type AutomationOwnerConflictCode =
  (typeof AUTOMATION_OWNER_CONFLICT_CODES)[keyof typeof AUTOMATION_OWNER_CONFLICT_CODES]

const CONFLICT_MESSAGES: Record<AutomationOwnerConflictCode, string> = {
  [AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged]:
    "This automation's host changed. Reload it before continuing.",
  [AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved]:
    "This automation's SSH host was removed, so it cannot run. Delete it or re-add that host.",
  [AUTOMATION_OWNER_CONFLICT_CODES.fencingRequired]:
    'This automation is pinned to an SSH host, so the request must name the host it expects.',
  [AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination]:
    'That host is no longer available on this authority. Pick a host and try again.'
}

export function automationOwnerConflictMessage(code: AutomationOwnerConflictCode): string {
  return CONFLICT_MESSAGES[code]
}

export class AutomationOwnerConflictError extends Error {
  readonly code: AutomationOwnerConflictCode

  constructor(code: AutomationOwnerConflictCode) {
    super(`${CONFLICT_MESSAGES[code]}: ${code}`)
    this.name = 'AutomationOwnerConflictError'
    this.code = code
  }
}

const CODE_VALUES: readonly AutomationOwnerConflictCode[] = Object.values(
  AUTOMATION_OWNER_CONFLICT_CODES
)

export function isAutomationOwnerConflictCode(
  value: unknown
): value is AutomationOwnerConflictCode {
  return typeof value === 'string' && CODE_VALUES.includes(value as AutomationOwnerConflictCode)
}

/**
 * The conflict an authority returned, whatever the transport left of it.
 *
 * The single classifier for every client: matching `.code` alone reads only the
 * hop that preserves the error class, and a flattened `runtime_error` would
 * then lose the recovery the user needs.
 */
export function matchAutomationOwnerConflict(error: unknown): AutomationOwnerConflictCode | null {
  for (const code of CODE_VALUES) {
    if (hasRuntimeRpcErrorCode(error, code)) {
      return code
    }
  }
  return null
}

/** Removes the trailing machine token so a conflict can be shown to a user verbatim. */
export function stripAutomationOwnerConflictCode(message: string): string {
  for (const code of CODE_VALUES) {
    const suffix = `: ${code}`
    if (message.trimEnd().endsWith(suffix)) {
      return message.trimEnd().slice(0, -suffix.length)
    }
  }
  return message
}
