// A structured session's legacy child shapes (`tasks`/`settledTasks`, `subagents`), derived from the
// host's child views so the old and new wire shapes cannot disagree. Clients that predate views read
// these, and they key rows by the id each lane published before views existed.

import type { AgentSessionHandleProvider } from './agent-session-provider-handle'
import {
  projectAgentChildWorkLegacyBackgroundTasks,
  projectAgentChildWorkLegacySubagents,
  type AgentChildWorkLegacyBackgroundProjection
} from './agent-status-child-work-projection'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import type { AgentSubagentSnapshot } from './agent-status-types'

/** The id a Codex subagent's background-task row has carried since before views; its view names
 *  the child by its bare thread id, the key its journal rows are linked by. */
export function codexAgentBackgroundTaskId(threadId: string): string {
  return `codex-agent:${threadId}`
}

function withLegacyIds(
  views: readonly AgentChildWorkView[],
  provider: AgentSessionHandleProvider
): AgentChildWorkView[] {
  return views.map((view) =>
    provider === 'codex' && view.kind === 'agent' && view.providerId !== undefined
      ? { ...view, providerId: codexAgentBackgroundTaskId(view.providerId) }
      : view
  )
}

export function structuredChildWorkLegacyTasks(
  views: readonly AgentChildWorkView[],
  provider: AgentSessionHandleProvider
): AgentChildWorkLegacyBackgroundProjection {
  return projectAgentChildWorkLegacyBackgroundTasks(withLegacyIds(views, provider))
}

export function structuredChildWorkLegacySubagents(
  views: readonly AgentChildWorkView[],
  provider: AgentSessionHandleProvider
): AgentSubagentSnapshot[] | undefined {
  return projectAgentChildWorkLegacySubagents(withLegacyIds(views, provider))
}
