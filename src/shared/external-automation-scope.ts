/**
 * Scoped external-automation requests.
 *
 * External managers are a desktop-only surface, so every scoped call carries the
 * captured desktop `AutomationOwnerRef` it was built from. The provider target is
 * *derived* from that owner and never accepted alongside it, so a caller cannot
 * name one host's owner while asking for another host's manager.
 *
 * The host-changed failure reuses `AutomationOwnerConflictError` rather than
 * introducing a second conflict vocabulary; the codes below cover only the
 * failures that are specific to this surface.
 */

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
  'hermes',
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
  targetHidden: 'external_automation_target_hidden',
  /** The relay answered `-32601`: it is healthy but has no external-runs method. */
  runsUnsupported: 'external_automation_runs_unsupported'
} as const

export type ExternalAutomationScopeCode =
  (typeof EXTERNAL_AUTOMATION_SCOPE_CODES)[keyof typeof EXTERNAL_AUTOMATION_SCOPE_CODES]

const SCOPE_MESSAGES: Record<ExternalAutomationScopeCode, string> = {
  [EXTERNAL_AUTOMATION_SCOPE_CODES.providerNotAllowed]:
    'That external automation provider is not supported.',
  [EXTERNAL_AUTOMATION_SCOPE_CODES.authorityNotSupported]:
    'External automation managers are available only on this computer and its SSH hosts.',
  [EXTERNAL_AUTOMATION_SCOPE_CODES.targetHidden]:
    'That host is managed by Orca and does not expose external automations.',
  [EXTERNAL_AUTOMATION_SCOPE_CODES.runsUnsupported]:
    'This host does not report external automation run history.'
}

/**
 * Carries its code as a trailing `: <code>` token, matching the automation owner
 * conflicts, because Electron IPC and older runtimes preserve nothing but the message.
 */
export class ExternalAutomationScopeError extends Error {
  readonly code: ExternalAutomationScopeCode

  constructor(code: ExternalAutomationScopeCode) {
    super(`${SCOPE_MESSAGES[code]}: ${code}`)
    this.name = 'ExternalAutomationScopeError'
    this.code = code
  }
}

const SCOPE_CODE_VALUES: readonly ExternalAutomationScopeCode[] = Object.values(
  EXTERNAL_AUTOMATION_SCOPE_CODES
)

export function isExternalAutomationScopeCode(
  value: unknown
): value is ExternalAutomationScopeCode {
  return (
    typeof value === 'string' && SCOPE_CODE_VALUES.includes(value as ExternalAutomationScopeCode)
  )
}

/** The captured incarnation no longer matches the current SSH registration. */
export function externalAutomationHostChangedError(): AutomationOwnerConflictError {
  return new AutomationOwnerConflictError(AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged)
}

/** The captured SSH host is gone, so nothing may be probed or launched on it. */
export function externalAutomationTargetRemovedError(): AutomationOwnerConflictError {
  return new AutomationOwnerConflictError(AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved)
}

/** Every scoped request; the target is derived from `owner`, never sent beside it. */
export type ScopedExternalAutomationRequest = {
  owner: AutomationOwnerRef
  provider: ExternalAutomationProvider
}

export type ScopedExternalManagerListRequest = ScopedExternalAutomationRequest & {
  /** Skips a cached entry that is still fresh; a probe is scheduled either way when absent. */
  refresh?: boolean
}

export type ScopedExternalManagerRunsRequest = ScopedExternalAutomationRequest & {
  jobId: string
  page: number
  pageSize: number
}

export type ScopedExternalManagerMutationFields = {
  name: string
  prompt: string
  schedule: string
  workdir: string | null
}

export type ScopedExternalManagerCreateRequest = ScopedExternalAutomationRequest &
  ScopedExternalManagerMutationFields

export type ScopedExternalManagerUpdateRequest = ScopedExternalManagerCreateRequest & {
  jobId: string
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

/**
 * Manager identity for a scope. The authority is implicit rather than encoded:
 * this surface is desktop-only, and the existing IDs are already persisted in
 * job, run, and dialog keys that older renderers still parse.
 */
export function externalAutomationManagerId(
  owner: AutomationOwnerRef,
  provider: ExternalAutomationProvider
): string {
  return owner.selector.kind === 'ssh'
    ? `${provider}:ssh:${owner.selector.targetId}`
    : `${provider}:local`
}
