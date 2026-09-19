// Read-only legacy views over the canonical child collection.
//
// These are the projections the background-task channel and the status summary become
// at cutover; nothing here writes. The bridge's four semantics live in
// `agent-status-child-work-projection.ts` and are applied to canonical rows, so the old
// wire keeps its closed vocabulary while the collection keeps the richer record.

import type { AgentSessionBackgroundTaskState } from './agent-session-background-task-wire'
import type { AgentChildWorkRecord } from './agent-status-child-work'
import {
  projectAgentChildWorkLegacyBackgroundTasks,
  projectAgentChildWorkLegacySubagents,
  type AgentChildWorkLegacyProjectionCandidate
} from './agent-status-child-work-projection'
import {
  STRUCTURED_CHILD_WORK_PRODUCER_ID,
  STRUCTURED_CHILD_WORK_SEGMENT_ID
} from './agent-status-child-work-structured-evidence'
import type { AgentStatusStore } from './agent-status-store'
import { agentStatusSubjectsEqual, type AgentStatusSubject } from './agent-status-subject'
import type { AgentSubagentSnapshot } from './agent-status-types'

export const STRUCTURED_SUPPORTS_TASK_STOP_FACT = 'structured.backgroundTasks.supportsTaskStop'
export const STRUCTURED_SUPPORTS_STOP_ALL_FACT = 'structured.backgroundTasks.supportsStopAll'

/** The provider id this child currently answers to, from its own invocation's alias.
 *  A retired invocation's alias is not an address for the live row. */
function currentProviderTaskId(
  store: AgentStatusStore,
  child: AgentChildWorkRecord
): string | null {
  for (const alias of store.getAliasesForChild(child.childWorkId)) {
    if (
      alias.aliasKind === 'task_id' &&
      alias.segmentId === STRUCTURED_CHILD_WORK_SEGMENT_ID &&
      alias.fence.invocationId === child.invocation.invocationId &&
      alias.fence.generation === child.invocation.generation
    ) {
      return alias.alias
    }
  }
  return null
}

/**
 * This producer's children for one parent, as legacy projection candidates. Ordered by
 * first observation then provider id: deterministic, and the same order the strip sorts
 * into, so a bounded projection always keeps the same rows.
 */
export function structuredChildWorkCandidates(
  store: AgentStatusStore,
  parent: AgentStatusSubject
): AgentChildWorkLegacyProjectionCandidate[] {
  const candidates: AgentChildWorkLegacyProjectionCandidate[] = []
  for (const child of store.getChildren(parent)) {
    if (
      child.provenance.producerId !== STRUCTURED_CHILD_WORK_PRODUCER_ID ||
      !agentStatusSubjectsEqual(child.parent, parent)
    ) {
      continue
    }
    const providerId = currentProviderTaskId(store, child)
    if (!providerId) {
      continue
    }
    candidates.push({
      providerId,
      child: {
        kind: child.kind,
        state: child.state,
        membership: child.membership,
        firstObservedAt: child.firstObservedAt,
        ...(child.name !== undefined ? { name: child.name } : {}),
        ...(child.description !== undefined ? { description: child.description } : {}),
        ...(child.agentType !== undefined ? { agentType: child.agentType } : {}),
        ...(child.model !== undefined ? { model: child.model } : {}),
        ...(child.totalTokens !== undefined ? { totalTokens: child.totalTokens } : {}),
        stoppable: child.stoppable
      }
    })
  }
  return candidates.sort((left, right) => {
    const delta = left.child.firstObservedAt - right.child.firstObservedAt
    return delta !== 0 ? delta : left.providerId < right.providerId ? -1 : 1
  })
}

/** The sidebar's `subagents`. Live only: the summary the bridge reads carries live
 *  `tasks` alone, so settled history must not reach this closed vocabulary. */
export function projectStructuredChildWorkSubagents(
  store: AgentStatusStore,
  parent: AgentStatusSubject
): AgentSubagentSnapshot[] | undefined {
  return projectAgentChildWorkLegacySubagents(
    structuredChildWorkCandidates(store, parent).filter(
      (candidate) => candidate.child.membership === 'live'
    )
  )
}

function readBooleanFact(
  store: AgentStatusStore,
  parent: AgentStatusSubject,
  key: string
): boolean | undefined {
  // The store exposes no keyed fact reader yet; cutover should add one rather than
  // materialize a snapshot per publication.
  for (const fact of store.getSnapshot().facts) {
    if (fact.key === key && agentStatusSubjectsEqual(fact.subject, parent)) {
      return typeof fact.value === 'boolean' ? fact.value : undefined
    }
  }
  return undefined
}

/** The strip's `backgroundTasks`, live and settled, with the session's own stop
 *  capability — a fact about the provider, not about any one row. */
export function projectStructuredChildWorkBackgroundTaskState(
  store: AgentStatusStore,
  parent: AgentStatusSubject
): AgentSessionBackgroundTaskState | null {
  const projected = projectAgentChildWorkLegacyBackgroundTasks(
    structuredChildWorkCandidates(store, parent)
  )
  if (!projected.tasks && !projected.settledTasks) {
    return null
  }
  const supportsTaskStop = readBooleanFact(store, parent, STRUCTURED_SUPPORTS_TASK_STOP_FACT)
  const supportsStopAll = readBooleanFact(store, parent, STRUCTURED_SUPPORTS_STOP_ALL_FACT)
  return {
    state: 'monitoring',
    ...projected,
    ...(supportsTaskStop !== undefined ? { supportsTaskStop } : {}),
    ...(supportsStopAll !== undefined ? { supportsStopAll } : {})
  }
}
