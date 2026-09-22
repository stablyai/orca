/**
 * Partitions the unscoped list an old authority returns.
 *
 * Nothing here guesses: Self needs positive evidence (a `local` record whose
 * project resolves with no SSH connection), a valid SSH record goes to its
 * target even when that target is only a ghost, and everything contradictory
 * lands in the orphan bucket. Legacy rows carry no registration generation, so
 * they are keyed by target ID alone and stay view-only until the authority
 * advertises owner fencing.
 *
 * The project evidence must come from the answering authority's own registry.
 * When the caller can only offer a mirror of it, an unresolved project is
 * reported as unverified: not knowing where a record lives is not the same
 * diagnosis as knowing its project was deleted.
 */

import type { Automation } from './automations-types'
import { AUTOMATION_ORPHAN_ISSUES } from './automation-list-scope'
import { getAutomationRunRepoId } from './automation-run-identity'
import { parseExecutionHostId } from './execution-host'

export type LegacyAutomationSelector =
  | { kind: 'self' }
  | { kind: 'ssh'; targetId: string }
  | { kind: 'orphan'; issue: string }

export type LegacyAutomationRow = {
  automation: Automation
  selector: LegacyAutomationSelector
}

export type LegacyAutomationPartition = {
  rows: LegacyAutomationRow[]
  orphanCount: number
}

export type LegacyAutomationPartitionContext = {
  /** `undefined` = this table has no such repo; `null` = a local repo; a string = its SSH connection. */
  repoConnectionId: (repoId: string) => string | null | undefined
  /**
   * Whether the table above is the answering authority's own project registry.
   * False for a table this client only mirrors, where a miss is an unread answer
   * rather than a deleted project.
   */
  projectsAuthoritative: boolean
}

function classify(
  automation: Automation,
  context: LegacyAutomationPartitionContext
): LegacyAutomationSelector {
  if (
    automation.schedulerOwner === 'remote_host_service' ||
    parseExecutionHostId(automation.runContext?.hostId)?.kind === 'runtime'
  ) {
    return { kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.scheduledElsewhere }
  }
  if (automation.executionTargetType === 'ssh') {
    const targetId = automation.executionTargetId?.trim()
    return targetId
      ? { kind: 'ssh', targetId }
      : { kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.malformed }
  }
  if (automation.executionTargetType !== 'local') {
    return { kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.malformed }
  }
  const connectionId = context.repoConnectionId(getAutomationRunRepoId(automation))
  if (connectionId === undefined) {
    return {
      kind: 'orphan',
      issue: context.projectsAuthoritative
        ? AUTOMATION_ORPHAN_ISSUES.projectMissing
        : AUTOMATION_ORPHAN_ISSUES.projectUnverified
    }
  }
  return connectionId
    ? { kind: 'orphan', issue: AUTOMATION_ORPHAN_ISSUES.malformed }
    : { kind: 'self' }
}

export function partitionLegacyAutomationList(
  automations: readonly Automation[],
  context: LegacyAutomationPartitionContext
): LegacyAutomationPartition {
  const rows = automations.map((automation) => ({
    automation,
    selector: classify(automation, context)
  }))
  return { rows, orphanCount: rows.filter((row) => row.selector.kind === 'orphan').length }
}
