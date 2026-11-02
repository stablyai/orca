/** Qualify external row/job/action keys by kind, captured owner and provider; manager IDs alone collide across hosts. */

import { ownerKey } from '../../../../shared/automation-owner-key'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import type {
  ExternalAutomationAction,
  ExternalAutomationProvider
} from '../../../../shared/automations-types'

const SEPARATOR = '|'

export type ExternalAutomationScopeRef = {
  owner: AutomationOwnerRef
  provider: ExternalAutomationProvider
}

// Why: components are escaped so a provider-supplied ID cannot forge another key.
function key(kind: string, scope: ExternalAutomationScopeRef, ...rest: string[]): string {
  return [kind, ownerKey(scope.owner), scope.provider, ...rest]
    .map((part) => encodeURIComponent(part))
    .join(SEPARATOR)
}

/** Cache, retention, and in-flight identity for one `{owner, provider}`. */
export function externalAutomationScopeKey(scope: ExternalAutomationScopeRef): string {
  return key('scope', scope)
}

export function externalAutomationManagerKey(
  scope: ExternalAutomationScopeRef,
  managerId: string
): string {
  return key('manager', scope, managerId)
}

export function externalAutomationJobKey(scope: ExternalAutomationScopeRef, jobId: string): string {
  return key('job', scope, jobId)
}

export function externalAutomationActionKey(
  scope: ExternalAutomationScopeRef,
  jobId: string,
  action: ExternalAutomationAction
): string {
  return key('action', scope, jobId, action)
}
