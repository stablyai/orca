import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type { AgentSessionBackgroundTaskState, AgentSessionLatestTurn } from './agent-session-wire'
import {
  runningStructuredAgentSessionTurnId,
  runningStructuredAgentSessionTurnScope
} from './structured-agent-session-live-turn'

const PRIMARY_COMMAND_PREFIX = 'codex-command:primary:'

export function codexPrimaryCommandTaskId(callId: string): string {
  return `${PRIMARY_COMMAND_PREFIX}${encodeURIComponent(callId)}`
}

/** Older hosts list foreground shells too; their journal still identifies which turn owns one. */
export function structuredSessionForegroundCommands(
  roster: AgentSessionBackgroundTaskState | null | undefined,
  source: { items: readonly AgentJournalRenderItem[]; latestTurn?: AgentSessionLatestTurn | null }
): ReadonlySet<string> {
  const foreground = new Set<string>()
  const turnId = runningStructuredAgentSessionTurnId(source)
  if (turnId === null || !roster) {
    return foreground
  }
  const scope = runningStructuredAgentSessionTurnScope(source)
  const owningTurnItems = new Map<string, string>()
  for (const item of source.items) {
    if (
      isRootAgentJournalItem(item) &&
      item.body.kind === 'tool-call' &&
      item.body.callId &&
      item.turnScope?.kind === 'turn'
    ) {
      owningTurnItems.set(codexPrimaryCommandTaskId(item.body.callId), item.turnScope.turnItemId)
    }
  }
  const firstObserved = new Map(
    (roster.children ?? []).flatMap((child) =>
      child.providerId ? [[child.providerId, child.firstObservedAt] as const] : []
    )
  )
  const ids = new Set([
    ...(roster.tasks ?? []).map((task) => task.id),
    ...(roster.children ?? []).flatMap((child) => child.providerId ?? [])
  ])
  for (const id of ids) {
    if (!id.startsWith(PRIMARY_COMMAND_PREFIX)) {
      continue
    }
    const observedAt = firstObserved.get(id)
    const owningTurnItem = owningTurnItems.get(id)
    const earlierTurn =
      owningTurnItem !== undefined && scope.kind === 'turn'
        ? owningTurnItem !== scope.turnItemId
        : observedAt !== undefined &&
          source.latestTurn != null &&
          observedAt < source.latestTurn.observedAt
    // With no ownership yet, keep an older host's start frame in the tool row until the turn ends.
    if (!earlierTurn) {
      foreground.add(id)
    }
  }
  return foreground
}
