import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import {
  projectNativeChatTranscript,
  type NativeChatSubagentRow,
  type NativeChatTranscriptProjection
} from '../../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import type { NativeChatTurnJournal } from '../../../../../../shared/native-chat/transcript/native-chat-turn-membership'
import {
  compareNativeChatDisplayMessages as compareMessages,
  orderNativeChatDisplayMessages as orderMessages
} from '../../../../../../shared/native-chat/transcript/native-chat-message-order'

function sameMessage(left: NativeChatMessage, right: NativeChatMessage): boolean {
  // Most rows retain input identity; only folded assistant runs need field comparison.
  if (left === right) {
    return true
  }
  const keys = Object.keys(left) as (keyof NativeChatMessage)[]
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && (key === 'blocks' || left[key] === right[key])
    ) &&
    left.blocks.length === right.blocks.length &&
    left.blocks.every((block, index) => block === right.blocks[index])
  )
}

function sameRows<T>(
  left: readonly T[] | undefined,
  right: readonly T[],
  same: (a: T, b: T) => boolean
): boolean {
  return (
    left !== undefined &&
    left.length === right.length &&
    left.every((item, index) => same(item, right[index]!))
  )
}

const sameSubagentRow = (a: NativeChatSubagentRow, b: NativeChatSubagentRow): boolean =>
  a.message === b.message && a.turnKey === b.turnKey

function plainAssistant(message: NativeChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.agentId === undefined &&
    message.blocks.every((block) => block.type === 'text' && !block.providerFrame)
  )
}

function sameTextPlacement(before: NativeChatMessage, next: NativeChatMessage): boolean {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime keys are used only for equality, including any extra message fields.
  const keys = Object.keys(before) as (keyof NativeChatMessage)[]
  return (
    keys.length === Object.keys(next).length &&
    keys.every((key) => {
      if (!Object.hasOwn(next, key)) {
        return false
      }
      if (key === 'blocks') {
        return true
      }
      if (key === 'journalPosition') {
        return (
          before.journalPosition?.sequence === next.journalPosition?.sequence &&
          before.journalPosition?.index === next.journalPosition?.index
        )
      }
      // Journal creation position, rather than a revised provider clock, orders these rows.
      return key === 'timestamp' && before.journalPosition && next.journalPosition
        ? true
        : before[key] === next[key]
    })
  )
}

function reuseConversation(
  messages: NativeChatMessage[],
  before: NativeChatMessage[] | null,
  previous: NativeChatTranscriptProjection,
  byId: ReadonlyMap<string, NativeChatMessage>,
  indexes: ReadonlyMap<NativeChatMessage, number>,
  rawIds: ReadonlySet<string>
): {
  conversation: NativeChatMessage[]
  changes: { index: number; message: NativeChatMessage; source: NativeChatMessage | null }[]
} | null {
  if (!before || messages.length < before.length || previous.subagentRows.size > 0) {
    return null
  }
  const changes: { index: number; message: NativeChatMessage; source: NativeChatMessage | null }[] =
    []
  for (let index = 0; index < before.length; index += 1) {
    const prior = before[index]!
    const message = messages[index]!
    if (prior === message) {
      continue
    }
    const projectedIndex = indexes.get(prior)
    // Folded rows can own later tools: only a directly drawn prose row is independent.
    if (
      projectedIndex === undefined ||
      !plainAssistant(prior) ||
      !plainAssistant(message) ||
      !sameTextPlacement(prior, message)
    ) {
      return null
    }
    changes.push({ index: projectedIndex, message, source: prior })
  }
  const appended = messages.slice(before.length)
  if (appended.length > 0) {
    let last: NativeChatMessage | undefined
    for (const message of before) {
      if (!message.journalPosition || message.pendingSend || message.queued) {
        return null
      }
      if (!last || compareMessages(last, message) < 0) {
        last = message
      }
    }
    const addedIds = new Set<string>()
    for (const message of appended) {
      if (
        !plainAssistant(message) ||
        !message.journalPosition ||
        message.pendingSend ||
        message.queued ||
        rawIds.has(message.id) ||
        byId.has(message.id) ||
        addedIds.has(message.id) ||
        (last && compareMessages(last, message) > 0)
      ) {
        return null
      }
      addedIds.add(message.id)
      last = message
    }
  }
  if (changes.length === 0 && appended.length === 0) {
    return { conversation: previous.conversation, changes }
  }
  const conversation = previous.conversation.slice()
  for (const { index, message } of changes) {
    conversation[index] = message
  }
  for (const message of appended) {
    changes.push({ index: conversation.length, message, source: null })
    conversation.push(message)
  }
  return { conversation, changes }
}

export function createNativeChatMessageListProjection(): (
  messages: NativeChatMessage[],
  journal?: NativeChatTurnJournal | null
) => NativeChatTranscriptProjection {
  let previous: NativeChatTranscriptProjection = { conversation: [], subagentRows: new Map() }
  let byId = new Map<string, NativeChatMessage>()
  let input: NativeChatMessage[] | null = null
  let indexes: Map<NativeChatMessage, number> | null = null
  let rawIds: Set<string> | null = null
  return (messages, journal) => {
    const reused =
      indexes && rawIds ? reuseConversation(messages, input, previous, byId, indexes, rawIds) : null
    const appendedStart = input?.length ?? 0
    input = messages
    if (reused) {
      if (reused.conversation !== previous.conversation) {
        // Reuse the index for content-only revisions; append changes only its new suffix.
        for (const { index, message, source } of reused.changes) {
          byId.set(message.id, message)
          if (source) {
            indexes!.delete(source)
          }
          indexes!.set(message, index)
        }
        for (let index = appendedStart; index < messages.length; index += 1) {
          rawIds!.add(messages[index]!.id)
        }
        previous = { ...previous, conversation: reused.conversation }
      }
      return previous
    }
    const projected = projectNativeChatTranscript(messages, compareMessages, journal, orderMessages)
    // Folding clones historical tool runs even when every contributing block is unchanged.
    const settle = (message: NativeChatMessage): NativeChatMessage => {
      const prior = byId.get(message.id)
      return prior && sameMessage(prior, message) ? prior : message
    }
    const conversation = projected.conversation.map(settle)
    const subagentRows = new Map<string, readonly NativeChatSubagentRow[]>()
    for (const [agentId, rows] of projected.subagentRows) {
      const settled = rows.map((row) => ({ ...row, message: settle(row.message) }))
      const prior = previous.subagentRows.get(agentId)
      subagentRows.set(
        agentId,
        prior && sameRows(prior, settled, sameSubagentRow) ? prior : settled
      )
    }
    const sameConversation = sameRows(previous.conversation, conversation, Object.is)
    const sameSubagents =
      subagentRows.size === previous.subagentRows.size &&
      Array.from(subagentRows).every(
        ([agentId, rows]) => previous.subagentRows.get(agentId) === rows
      )
    const independent = subagentRows.size === 0
    rawIds = independent ? new Set(messages.map((message) => message.id)) : null
    // Settlement can restore raw identity after a fold; only canonical output proves provenance.
    indexes =
      rawIds?.size === messages.length
        ? new Map(projected.conversation.map((message, index) => [message, index]))
        : null
    if (indexes?.size !== projected.conversation.length) {
      indexes = null
    }
    if (sameConversation && sameSubagents) {
      return previous
    }
    previous = {
      conversation: sameConversation ? previous.conversation : conversation,
      subagentRows: sameSubagents ? previous.subagentRows : subagentRows
    }
    byId = new Map(
      [
        ...conversation,
        ...Array.from(subagentRows.values())
          .flat()
          .map((row) => row.message)
      ].map((message) => [message.id, message])
    )
    return previous
  }
}
