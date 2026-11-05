import {
  finishAgentSessionSteps,
  filterAgentSessionSteps,
  indexAgentSessionSteps
} from '../../agent-session/agent-session-projection-steps'
import { agentJournalItemPosition } from '../../agent-session/journal/agent-session-journal-position'
import type { AgentJournalRenderItem } from '../../agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../native-chat-types'

/** A split result row keeps its source's journal position while gaining its own render identity. */
export function nativeChatTurnRowAttribution<T>(
  messages: readonly Pick<NativeChatMessage, 'id' | 'role' | 'journalPosition'>[],
  items: readonly AgentJournalRenderItem[],
  attribution: ReadonlyMap<string, T>
): ReadonlyMap<string, T> {
  return finishAgentSessionSteps(nativeChatTurnRowAttributionSteps(messages, items, attribution))
}
export function* nativeChatTurnRowAttributionSteps<T>(
  messages: readonly Pick<NativeChatMessage, 'id' | 'role' | 'journalPosition'>[],
  items: readonly AgentJournalRenderItem[],
  attribution: ReadonlyMap<string, T>
): Generator<void, ReadonlyMap<string, T>> {
  const detached = yield* filterAgentSessionSteps(
    messages,
    (message) =>
      message.role === 'tool' &&
      message.journalPosition !== undefined &&
      !attribution.has(message.id)
  )
  if (detached.length === 0) {
    return attribution
  }
  const itemIds = new Set<string>()
  const sources = new Map<string, string | null>()
  for (const item of items) {
    yield
    itemIds.add(item.itemId)
    const { sequence, index } = agentJournalItemPosition(item)
    const position = `${sequence}:${index}`
    sources.set(position, sources.has(position) ? null : item.itemId)
  }
  let attributed: Map<string, T> | undefined
  for (const message of detached) {
    yield
    const position = message.journalPosition
    if (!position || itemIds.has(message.id)) {
      continue
    }
    const sourceId = sources.get(`${position.sequence}:${position.index}`)
    const value = sourceId ? attribution.get(sourceId) : undefined
    if (value !== undefined) {
      attributed ??= yield* indexAgentSessionSteps(attribution)
      attributed.set(message.id, value)
    }
  }
  return attributed ?? attribution
}
