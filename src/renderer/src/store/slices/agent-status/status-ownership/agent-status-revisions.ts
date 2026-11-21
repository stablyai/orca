import { agentStatusEvidenceObservedAt } from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import { agentVerdictDisplayMark } from '../../../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import { resolveProgramStatusPresentation } from '../../../../../../shared/program-status/presentation'
import { structuralValuesEqualIgnoringUndefined as equal } from '../../../../../../shared/collections/structural-value-equality'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { AcceptedAgentStatuses } from './accepted-agent-statuses'

type AgentStatusRevision =
  | 'activityDetailsRevision'
  | 'storageActivityRevision'
  | 'runtimeTasksRevision'

export function sameAcceptedStatusRevision(
  before: AcceptedAgentStatuses,
  after: AcceptedAgentStatuses,
  revision: AgentStatusRevision
): boolean {
  return before === after || (before.sharesOwner(after) && before[revision] === after[revision])
}

export function selectStatusByRevision(
  revision: AgentStatusRevision
): (state: { agentStatusByPaneKey: AcceptedAgentStatuses }) => AcceptedAgentStatuses {
  let previous: AcceptedAgentStatuses | undefined
  return ({ agentStatusByPaneKey }) => {
    if (!previous || !sameAcceptedStatusRevision(previous, agentStatusByPaneKey, revision)) {
      previous = agentStatusByPaneKey
    }
    return previous
  }
}

export function activityDetailsFact(entry: AgentStatusEntry | undefined) {
  if (!entry) {
    return undefined
  }
  const { model: _model, modelSwitchCommand: _switch, acceptedStatusSeq: _seq, ...details } = entry
  return details
}

export function sameActivityStatusEntries(
  before: readonly AgentStatusEntry[],
  after: readonly AgentStatusEntry[]
): boolean {
  return (
    before === after ||
    (before.length === after.length &&
      after.every(
        (row, index) =>
          row === before[index] ||
          equal(activityDetailsFact(row), activityDetailsFact(before[index]))
      ))
  )
}

export function storageActivityFact(entry: AgentStatusEntry | undefined) {
  if (!entry || entry.restoredUnconfirmed || entry.state === 'done') {
    return undefined
  }
  return [entry.paneKey, entry.structuredHostOwned ? null : agentStatusEvidenceObservedAt(entry)]
}

export function runtimeTaskFact(entry: AgentStatusEntry | undefined) {
  return entry && entry.state !== 'done' ? [entry.worktreeId, entry.tabId] : undefined
}

export function activityFact(entry: AgentStatusEntry | undefined): readonly unknown[] | undefined {
  if (!entry) {
    return undefined
  }
  const progress = resolveProgramStatusPresentation(entry).progress
  return [
    entry.paneKey,
    entry.state,
    entry.workingMode,
    agentVerdictDisplayMark(entry),
    entry.restoredUnconfirmed,
    entry.structuredHostOwned,
    entry.structuredHostOwned ? undefined : agentStatusEvidenceObservedAt(entry),
    progress,
    progress === undefined ? undefined : entry.updatedAt
  ]
}
