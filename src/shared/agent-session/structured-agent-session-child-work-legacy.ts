// Derive legacy tasks/settledTasks/subagents from host views so old/new readers agree while retaining each lane’s original IDs.
// Remove the wire bridge only when MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION exceeds protocol 3, when
// agent-session.background-task-child-views.v1 first shipped: remove structuredChildWorkLegacyTasks, codexAgentBackgroundTaskId,
// summary backgroundTasks, channel tasks/settledTasks and withoutChildViews together. New child facts must serve old readers until then.
// structuredChildWorkLegacySubagents is in-app, not wire; retain it until AgentStatusEntry.subagents readers use children.

import type { StructuredAgentId } from '../agent-session-provider-handle'
import { codexChildCommandDescription } from '../codex-child-command-description'
import {
  projectAgentChildWorkLegacyBackgroundTasks,
  projectAgentChildWorkLegacySubagents,
  type AgentChildWorkLegacyBackgroundProjection
} from '../agent-status-child-work-projection'
import type { AgentChildWorkView } from '../agent-status-child-work-view'
import type { AgentSubagentSnapshot } from '../agent-status-subagent-snapshot'

/** Keep the pre-view Codex background-task ID; journal links use the bare thread ID. */
export function codexAgentBackgroundTaskId(threadId: string): string {
  return `codex-agent:${threadId}`
}

function withLegacyIds(
  views: readonly AgentChildWorkView[],
  provider: StructuredAgentId
): AgentChildWorkView[] {
  return views.map((view) =>
    provider === 'codex' && view.kind === 'agent' && view.providerId !== undefined
      ? // A Stop names the row's id, which no host record carries: these rows offer none.
        { ...view, providerId: codexAgentBackgroundTaskId(view.providerId), stoppable: false }
      : view
  )
}

/** Legacy rosters hide commands under a running Codex child, then expose them as <agent> — <command> after it finishes. */
function withCodexChildCommands(views: readonly AgentChildWorkView[]): AgentChildWorkView[] {
  const byId = new Map(views.map((view) => [view.id, view]))
  return views.flatMap((view) => {
    const owner = view.parentChildWorkId ? byId.get(view.parentChildWorkId) : undefined
    if (view.kind !== 'command' || owner?.kind !== 'agent') {
      return [view]
    }
    if (owner.membership !== 'settled') {
      return []
    }
    const label = owner.description ?? owner.name
    return [
      label ? { ...view, description: codexChildCommandDescription(label, view.description) } : view
    ]
  })
}

export function structuredChildWorkLegacyTasks(
  views: readonly AgentChildWorkView[],
  provider: StructuredAgentId
): AgentChildWorkLegacyBackgroundProjection {
  return projectAgentChildWorkLegacyBackgroundTasks(
    withLegacyIds(provider === 'codex' ? withCodexChildCommands(views) : views, provider)
  )
}

export function structuredChildWorkLegacySubagents(
  views: readonly AgentChildWorkView[],
  provider: StructuredAgentId
): AgentSubagentSnapshot[] | undefined {
  return projectAgentChildWorkLegacySubagents(withLegacyIds(views, provider))
}
