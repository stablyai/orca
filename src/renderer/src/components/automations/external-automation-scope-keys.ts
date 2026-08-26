/**
 * Keys for external manager rows, jobs, runs, dialogs, and in-flight actions.
 *
 * A provider's manager ID is unique only inside one host, so a key built from it
 * alone collides the moment two hosts run the same provider — the selected row,
 * the open dialog, and the disabled action button would all follow the wrong
 * host. Every key is therefore prefixed with its kind, the captured owner, and
 * the provider.
 */

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

export function externalAutomationRunKey(
  scope: ExternalAutomationScopeRef,
  jobId: string,
  runId: string
): string {
  return key('run', scope, jobId, runId)
}

export function externalAutomationActionKey(
  scope: ExternalAutomationScopeRef,
  jobId: string,
  action: ExternalAutomationAction
): string {
  return key('action', scope, jobId, action)
}

/** A create dialog has no job yet, and 'new' is a segment of its own so a job literally named "new" cannot alias it. */
export function externalAutomationDialogKey(
  scope: ExternalAutomationScopeRef,
  jobId: string | null
): string {
  return jobId === null ? key('dialog', scope, 'new') : key('dialog', scope, 'job', jobId)
}
