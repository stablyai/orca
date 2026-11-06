import type { Automation } from '../../../../shared/automations-types'
import { AUTOMATION_ORPHAN_ISSUES } from '../../../../shared/automation-list-scope'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { automationAuthorityCatalogKey } from './automation-host-catalog-types'
import type { AutomationCapturedOwner } from './automation-captured-owner'
import type { AutomationCreateDestination } from './automation-create-destination'

export function isSameAutomationWorkspace(
  automation: Automation,
  draft: Pick<Automation, 'projectId' | 'workspaceId' | 'workspaceMode'>
): boolean {
  return (
    automation.projectId === draft.projectId &&
    automation.workspaceMode === draft.workspaceMode &&
    (automation.workspaceId ?? '') === (draft.workspaceId ?? '')
  )
}

/** A saved target is a proposal to its authority, never an executable catalog Repo. */
export function recordedAutomationRunContext(
  automation: Automation | null,
  captured: AutomationCapturedOwner,
  destination: AutomationCreateDestination
) {
  const context = automation?.runContext
  const host = parseExecutionHostId(context?.hostId)
  const selector = destination.destination.selector
  return context &&
    host?.kind === 'ssh' &&
    captured.authority &&
    captured.selector?.kind === 'orphan' &&
    captured.selector.issue === AUTOMATION_ORPHAN_ISSUES.hostReselection &&
    automationAuthorityCatalogKey(captured.authority) ===
      automationAuthorityCatalogKey(destination.authority) &&
    selector.kind === 'ssh' &&
    selector.targetId === host.targetId
    ? context
    : null
}
