/** Partition old unscoped lists with positive owner evidence: Self needs a resolved local project; valid SSH targets may be ghosts; contradictions are orphans. Generation-less rows stay view-only until owner fencing. Registry evidence must come from the answering authority; unresolved mirrors mean unverified, not deleted. */

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
  /** Only the answering authority's own registry proves deletion; misses in a client mirror remain unverified. */
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
