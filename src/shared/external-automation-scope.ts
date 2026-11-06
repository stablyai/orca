/** External managers are desktop-only; derive targets from captured AutomationOwnerRef so callers cannot mix owners and hosts.
 * Host changes reuse AutomationOwnerConflictError; the codes here cover surface-specific failures. */

import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  AutomationOwnerConflictError
} from './automation-owner-conflict'
import type { AutomationOwnerRef } from './automation-owner-ref'
import type {
  ExternalAutomationAction,
  ExternalAutomationProvider,
  ExternalAutomationTarget
} from './automations-types'

export const EXTERNAL_AUTOMATION_PROVIDERS = [
  'openclaw'
] as const satisfies readonly ExternalAutomationProvider[]

export function isExternalAutomationProvider(value: unknown): value is ExternalAutomationProvider {
  return (
    typeof value === 'string' &&
    (EXTERNAL_AUTOMATION_PROVIDERS as readonly string[]).includes(value)
  )
}

export const EXTERNAL_AUTOMATION_SCOPE_CODES = {
  /** The provider is not on the allowlist, so no command or relay call may be attempted. */
  providerNotAllowed: 'external_automation_provider_not_allowed',
  /** Only the desktop authority owns external managers; runtime authorities must not be tunnelled. */
  authorityNotSupported: 'external_automation_authority_not_supported',
  /** The SSH target is an Orca implementation detail and stays out of user-facing surfaces. */
  targetHidden: 'external_automation_target_hidden'
} as const

export type ExternalAutomationScopeCode =
  (typeof EXTERNAL_AUTOMATION_SCOPE_CODES)[keyof typeof EXTERNAL_AUTOMATION_SCOPE_CODES]

const SCOPE_MESSAGES: Record<ExternalAutomationScopeCode, string> = {
  [EXTERNAL_AUTOMATION_SCOPE_CODES.providerNotAllowed]:
    'That external automation provider is not supported.',
  [EXTERNAL_AUTOMATION_SCOPE_CODES.authorityNotSupported]:
    'External automation managers are available only on this computer and its SSH hosts.',
  [EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden]:
    'Orca runs on that host, so it does not expose external automations.'
}

/** Trailing : <code> survives Electron IPC and older runtimes that preserve only the message, matching owner conflicts. */
export class ExternalAutomationScopeError extends Error {
  readonly code: ExternalAutomationScopeCode

  constructor(code: ExternalAutomationScopeCode) {
    super(`${SCOPE_MESSAGES[code]}: ${code}`)
    this.name = 'ExternalAutomationScopeError'
    this.code = code
  }
}

/** The captured incarnation no longer matches the current SSH registration. */
export function externalAutomationHostChangedError(): AutomationOwnerConflictError {
  return new AutomationOwnerConflictError(AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged)
}

/** The captured SSH host is gone, so nothing may be probed or launched on it. */
export function externalAutomationTargetRemovedError(): AutomationOwnerConflictError {
  return new AutomationOwnerConflictError(AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved)
}

/** Targets are derived from owner, never supplied separately. */
export type ScopedExternalAutomationRequest = {
  owner: AutomationOwnerRef
  provider: ExternalAutomationProvider
}

export type ScopedExternalManagerListRequest = ScopedExternalAutomationRequest & {
  /** Skips a cached entry that is still fresh; a probe is scheduled either way when absent. */
  refresh?: boolean
}

export type ScopedExternalManagerActionRequest = ScopedExternalAutomationRequest & {
  jobId: string
  action: ExternalAutomationAction
}

/** Target IDs stay identifiers: this is the only place a selector becomes a target. */
export function externalAutomationTargetForOwner(
  owner: AutomationOwnerRef
): ExternalAutomationTarget {
  return owner.selector.kind === 'ssh'
    ? { type: 'ssh', connectionId: owner.selector.targetId }
    : { type: 'local' }
}

/** Desktop authority is implicit: existing IDs persist in job/run/dialog keys parsed by older renderers. */
export function externalAutomationManagerId(
  owner: AutomationOwnerRef,
  provider: ExternalAutomationProvider
): string {
  return owner.selector.kind === 'ssh'
    ? `${provider}:ssh:${owner.selector.targetId}`
    : `${provider}:local`
}
