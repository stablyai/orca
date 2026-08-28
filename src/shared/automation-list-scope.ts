/**
 * The `automation.list` request/response contract.
 *
 * The request is host-scoped inside one authority: the authority itself is the
 * IPC endpoint or the paired RPC connection and is never a caller-chosen field.
 * An omitted selector is the legacy request and still answers with the
 * authority's complete list, so an old client reading a new host is unaffected.
 *
 * The response keeps `automations` for those old clients and adds `items`,
 * which qualifies each row with the selector that actually produced it. Rows are
 * paired by ID rather than nested so the legacy field is not duplicated on the
 * wire.
 */

import type { Automation } from './automations-types'
import type { AutomationUsageSummary } from './automation-usage-summary'
import { getAutomationRunRepoId } from './automation-run-identity'
import { parseExecutionHostId } from './execution-host'
import { sanitizeSshTargetGeneration } from './ssh-target-generation'
import { isWorkspaceSshPinRepinned } from './automation-workspace-repin'

export type AutomationListScopeSelector =
  | { kind: 'self' }
  | { kind: 'ssh'; targetId: string; expectedTargetGeneration: number }
  | { kind: 'orphan' }

export type AutomationListParams = {
  /** Omitted, like `null` or `{}`, requests the authority's complete list. */
  selector?: AutomationListScopeSelector
}

export type AutomationListItemSelector =
  | { kind: 'self' }
  | { kind: 'ssh'; targetId: string; targetGeneration: number }
  | { kind: 'orphan'; issue: string }

export type AutomationListItem = {
  automationId: string
  selector: AutomationListItemSelector
  usageSummary?: AutomationUsageSummary | null
}

export type AutomationListResult = {
  automations: Automation[]
  items: AutomationListItem[]
  /**
   * Orphans across the whole authority, so any scoped answer can reveal the
   * orphan bucket. Optional on the wire, and absent must stay absent: a zero
   * here settles a bucket nobody counted.
   */
  orphanCount?: number
}

/** What a host with no scoped list support returns, and all an old client reads. */
export type LegacyAutomationListResult = { automations: Automation[] }

export const AUTOMATION_ORPHAN_ISSUES = {
  targetMissing: 'Its SSH host is no longer registered.',
  targetReplaced: 'Its SSH host was removed and re-added, so it must be re-adopted.',
  scheduledElsewhere: 'It is stored here but scheduled against a remote runtime.',
  projectMissing: 'Its project no longer exists, so its host cannot be resolved.',
  projectUnverified: 'Its project could not be checked from here, so its host is unconfirmed.',
  workspaceHostAmbiguous: 'Its workspace spans more than one host, so it has no single owner.',
  malformed: 'Its stored host record is incomplete.'
} as const

/** Where a record's workspace executes; `unpinned` leaves the repo to decide. */
export type AutomationWorkspaceHost =
  | { kind: 'unpinned' }
  | { kind: 'local' }
  | { kind: 'ssh'; targetId: string }
  | { kind: 'ambiguous' }

export type AutomationProjectionContext = {
  /** The process that owns this store; runtime scheduling markers are local only on a runtime. */
  storageAuthority?: 'desktop' | 'runtime'
  /** Current registration generation of a saved SSH target; undefined once it is gone. */
  sshTargetGeneration: (targetId: string) => number | undefined
  /** `undefined` = the repo is gone; `null` = a local repo; a string = its SSH connection. */
  repoConnectionId: (repoId: string) => string | null | undefined
  /** Host the record's workspace pins it to; omitted means no side knows of a pin. */
  workspaceHost?: (automation: Automation) => AutomationWorkspaceHost
  /** Registration a generation was allocated to; omitted leaves a re-pin unproven. */
  sshTargetIdForGeneration?: (generation: number) => string | undefined
  usageSummary?: (automationId: string) => AutomationUsageSummary | null
}

function orphan(issue: string): AutomationListItemSelector {
  return { kind: 'orphan', issue }
}

function sshSelector(
  automation: Automation,
  context: AutomationProjectionContext
): AutomationListItemSelector {
  const targetId = automation.executionTargetId?.trim()
  if (!targetId) {
    return orphan(AUTOMATION_ORPHAN_ISSUES.malformed)
  }
  return sshTargetSelector(targetId, automation.executionTargetGeneration, context)
}

function sshTargetSelector(
  targetId: string,
  capturedGeneration: number | undefined,
  context: AutomationProjectionContext
): AutomationListItemSelector {
  const current = context.sshTargetGeneration(targetId)
  if (current === undefined) {
    return orphan(AUTOMATION_ORPHAN_ISSUES.targetMissing)
  }
  const captured = sanitizeSshTargetGeneration(capturedGeneration)
  if (captured !== undefined && captured !== current) {
    return orphan(AUTOMATION_ORPHAN_ISSUES.targetReplaced)
  }
  return { kind: 'ssh', targetId, targetGeneration: captured ?? current }
}

/**
 * The pin decides the host; the capture only decides whether this incarnation of
 * it is the one the record was attached to. A capture a different live
 * registration carries came from the pin the workspace has since moved off, so
 * it says nothing about this one and is dropped rather than read as a mismatch.
 */
function workspacePinSelector(
  automation: Automation,
  targetId: string,
  context: AutomationProjectionContext
): AutomationListItemSelector {
  const repinned = isWorkspaceSshPinRepinned({
    capturedGeneration: automation.executionTargetGeneration,
    pin: { targetId, generation: context.sshTargetGeneration(targetId) },
    sshTargetIdForGeneration: context.sshTargetIdForGeneration
  })
  return sshTargetSelector(
    targetId,
    repinned ? undefined : automation.executionTargetGeneration,
    context
  )
}

/**
 * Runtime scheduling markers are owned only in runtime storage. A bare `local`
 * still needs a resolvable local project before it is evidence of Self.
 */
export function projectAutomationSelector(
  automation: Automation,
  context: AutomationProjectionContext
): AutomationListItemSelector {
  if (
    context.storageAuthority !== 'runtime' &&
    (automation.schedulerOwner === 'remote_host_service' ||
      parseExecutionHostId(automation.runContext?.hostId)?.kind === 'runtime')
  ) {
    return orphan(AUTOMATION_ORPHAN_ISSUES.scheduledElsewhere)
  }
  if (automation.executionTargetType === 'ssh') {
    return sshSelector(automation, context)
  }
  if (automation.executionTargetType !== 'local') {
    return orphan(AUTOMATION_ORPHAN_ISSUES.malformed)
  }
  const workspaceHost = context.workspaceHost?.(automation) ?? { kind: 'unpinned' }
  if (workspaceHost.kind === 'ambiguous') {
    return orphan(AUTOMATION_ORPHAN_ISSUES.workspaceHostAmbiguous)
  }
  // A pinned workspace is where the run actually goes, so the row belongs to that host, not Self.
  if (workspaceHost.kind === 'ssh') {
    return workspacePinSelector(automation, workspaceHost.targetId, context)
  }
  const connectionId = context.repoConnectionId(getAutomationRunRepoId(automation))
  if (connectionId === undefined) {
    return orphan(AUTOMATION_ORPHAN_ISSUES.projectMissing)
  }
  // A local record whose project points at an SSH connection contradicts itself.
  return connectionId ? orphan(AUTOMATION_ORPHAN_ISSUES.malformed) : { kind: 'self' }
}

/** The orphan diagnoses that answer "does this record still have one usable host?" */
export type AutomationCapturedHostIssue =
  | typeof AUTOMATION_ORPHAN_ISSUES.targetMissing
  | typeof AUTOMATION_ORPHAN_ISSUES.targetReplaced
  | typeof AUTOMATION_ORPHAN_ISSUES.workspaceHostAmbiguous

// Keyed by the union, not a list of it: a list stays valid when the union grows, so a
// fourth diagnosis would compile while never reaching dispatch. This makes omitting it here
// the compile error, not just omitting its message.
const CAPTURED_HOST_ISSUES: Record<AutomationCapturedHostIssue, true> = {
  [AUTOMATION_ORPHAN_ISSUES.targetMissing]: true,
  [AUTOMATION_ORPHAN_ISSUES.targetReplaced]: true,
  // No single owner is as unrunnable as no owner: dispatching would pick a host the user never chose.
  [AUTOMATION_ORPHAN_ISSUES.workspaceHostAmbiguous]: true
}

function isCapturedHostIssue(issue: string): issue is AutomationCapturedHostIssue {
  return Object.hasOwn(CAPTURED_HOST_ISSUES, issue)
}

/**
 * Which host-identity diagnosis stands against the record, if any.
 *
 * Dispatch reads the list's verdict instead of re-deriving one, so the two can
 * never disagree about the host a record belongs to. The diagnosis is returned
 * rather than a yes/no because callers must keep the two apart: a gone host and
 * a replaced one need different answers for the user, and run coalescing folds
 * only on identical text. The other orphan reasons are different questions and
 * stay with whoever already answers them — notably `scheduledElsewhere`, which
 * is what a remote server's own scheduler is there to run.
 */
export function automationCapturedHostIssue(
  automation: Automation,
  context: AutomationProjectionContext
): AutomationCapturedHostIssue | null {
  const selector = projectAutomationSelector(automation, context)
  if (selector.kind !== 'orphan') {
    return null
  }
  return isCapturedHostIssue(selector.issue) ? selector.issue : null
}

export function automationSelectorMatchesScope(
  selector: AutomationListItemSelector,
  scope: AutomationListScopeSelector
): boolean {
  if (scope.kind === 'ssh') {
    return (
      selector.kind === 'ssh' &&
      selector.targetId === scope.targetId &&
      selector.targetGeneration === scope.expectedTargetGeneration
    )
  }
  return selector.kind === scope.kind
}

/** Projects every stored automation, then narrows to the requested scope. */
export function projectAutomationList(
  automations: readonly Automation[],
  context: AutomationProjectionContext,
  scope?: AutomationListScopeSelector
): AutomationListResult {
  const projected = automations.map((automation) => ({
    automation,
    selector: projectAutomationSelector(automation, context)
  }))
  const orphanCount = projected.filter((entry) => entry.selector.kind === 'orphan').length
  const scoped = scope
    ? projected.filter((entry) => automationSelectorMatchesScope(entry.selector, scope))
    : projected
  return {
    automations: scoped.map((entry) => entry.automation),
    items: scoped.map((entry) => ({
      automationId: entry.automation.id,
      selector: entry.selector,
      ...(context.usageSummary ? { usageSummary: context.usageSummary(entry.automation.id) } : {})
    })),
    orphanCount
  }
}

/** What a scoped `automationsChanged` event names; carries no incarnation, only the stable host. */
export type AutomationChangeSelector =
  | { kind: 'self' }
  | { kind: 'ssh'; targetId: string }
  | { kind: 'orphan' }

export function toAutomationChangeSelector(
  selector: AutomationListItemSelector
): AutomationChangeSelector {
  return selector.kind === 'ssh'
    ? { kind: 'ssh', targetId: selector.targetId }
    : { kind: selector.kind }
}

/**
 * The selectors a mutation must publish. A move publishes both source and
 * destination; an unrecoverable side degrades the whole publication to one
 * unscoped authority event, because a subscriber that never hears about the
 * entry it is showing would keep rendering a row that no longer exists.
 */
export function automationChangePublications(
  before: AutomationChangeSelector | null,
  after: AutomationChangeSelector | null
): (AutomationChangeSelector | undefined)[] {
  if (!before || !after) {
    return [undefined]
  }
  const sameHost =
    before.kind === after.kind &&
    (before.kind !== 'ssh' || after.kind !== 'ssh' || before.targetId === after.targetId)
  return sameHost ? [after] : [before, after]
}
