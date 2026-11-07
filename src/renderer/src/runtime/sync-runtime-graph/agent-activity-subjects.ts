import type { AppState } from '@/store/types'
import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import {
  buildActivityEvents,
  createActivityEventBuildCache
} from '../../components/activity/activity-event-builder'
import { getWorktreeExecutionHostId } from '../../../../shared/execution-host'
import type { AgentActivitySubject } from '../../../../shared/agent-activity-read-state'
import type { StructuredChatTabNames } from '../structured-chat-tab-name'

const cache = createActivityEventBuildCache()
const names: StructuredChatTabNames = new Map()

export function buildAgentActivitySubjects(state: AppState): AgentActivitySubject[] {
  if (
    !Object.keys(state.agentStatusByPaneKey ?? {}).length &&
    !Object.keys(state.retainedAgentsByPaneKey ?? {}).length &&
    !Object.keys(state.migrationUnsupportedByPtyId ?? {}).length
  ) {
    return []
  }
  const tabsByWorktree = state.tabsByWorktree ?? {}
  const unifiedTabsByWorktree = state.unifiedTabsByWorktree
  const { events, paneEntryByPaneKey } = buildActivityEvents(
    {
      chatNames: names,
      agentStatusByPaneKey: state.agentStatusByPaneKey ?? {},
      retainedAgentsByPaneKey: state.retainedAgentsByPaneKey ?? {},
      migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
      runtimeAgentOrchestrationByPaneKey: state.runtimeAgentOrchestrationByPaneKey,
      tabsByWorktree,
      unifiedTabsByWorktree,
      worktreeMap: getWorktreeMapFromState(state),
      repoMap: getRepoMapFromState(state),
      repos: state.repos,
      resolveWorktree: state.getKnownWorktreeById,
      acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey ?? {},
      activityClearedAtByPaneKey: state.activityClearedAtByPaneKey,
      now: Date.now()
    },
    cache
  )
  const subjects = new Map<string, AgentActivitySubject>()
  for (const event of events) {
    const paneKey = event.entry.paneKey
    const hostId = getWorktreeExecutionHostId(event.worktree, event.repo ?? undefined)
    const key = JSON.stringify([hostId, event.worktree.id, paneKey])
    const existing = subjects.get(key)
    if (existing) {
      existing.latestActivityAt = Math.max(existing.latestActivityAt, event.timestamp)
    } else {
      subjects.set(key, {
        paneKey,
        worktreeId: event.worktree.id,
        hostId,
        latestActivityAt: event.timestamp,
        stateStartedAt: paneEntryByPaneKey[paneKey]?.stateStartedAt ?? event.entry.stateStartedAt
      })
    }
  }
  return [...subjects.values()]
}
