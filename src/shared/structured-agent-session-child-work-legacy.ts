// A structured session's legacy child shapes (`tasks`/`settledTasks`, `subagents`), derived from the
// host's child views so the old and new wire shapes cannot disagree. Clients that predate views read
// these, and they key rows by the id each lane published before views existed.
//
// Death condition: this is a bridge for clients that do not advertise
// `agent-session.background-task-child-views.v1`. Once MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION is raised
// past the RUNTIME_PROTOCOL_VERSION in force when that capability first shipped (3), every admitted
// client reads `children`, and these go together: `structuredChildWorkLegacyTasks` with
// `codexAgentBackgroundTaskId`, the status summary's `backgroundTasks` derivation, the channel's
// `tasks`/`settledTasks`, and the capability gate's `withoutChildViews`. Until then a new child fact
// must be decided here for those older readers too. `structuredChildWorkLegacySubagents` is not wire:
// it feeds in-app readers of `AgentStatusEntry.subagents`, and dies when they read `children`.

import type { StructuredAgentId } from './agent-session-provider-handle'
import { codexChildCommandDescription } from './codex-child-command-description'
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
  provider: StructuredAgentId
): AgentChildWorkView[] {
  return views.map((view) =>
    provider === 'codex' && view.kind === 'agent' && view.providerId !== undefined
      ? // A Stop names the row's id, which no host record carries: these rows offer none.
        { ...view, providerId: codexAgentBackgroundTaskId(view.providerId), stoppable: false }
      : view
  )
}

/** A Codex child agent's commands as the flat roster showed them before views: hidden while the
 *  agent runs (its row stands for them), then named "<agent> — <command>" once it has finished. */
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
