import { useMemo } from 'react'
import { latestAgentSessionContextClearSequence } from '../../../../../shared/agent-session/agent-session-context-clear'
import type { AgentSessionLatestTurn } from '../../../../../shared/agent-session/agent-session-wire'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSubagentRoster } from '../../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type {
  NativeChatMessage,
  NativeChatSubagentEntry
} from '../../../../../shared/native-chat/native-chat-types'
import { normalizeSubagentState } from '../../../../../shared/native-chat/transcript/native-chat-subagent-summary'
import type { NativeChatSubagentRow } from '../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import {
  useNativeChatTurnMembership,
  type NativeChatTurnRows
} from '../conversation/slots/use-native-chat-turn-membership'
import type { NativeChatSubagentView } from './native-chat-open-subagent'
import { nativeChatSubagentHistoryStep } from './native-chat-subagent-history'
import {
  nativeChatSubagentEntries,
  nativeChatSubagentHeads,
  nativeChatSubagentRowsInOrder
} from './native-chat-subagent-scope'
import { NativeChatSubagentViewBar } from './NativeChatSubagentViewBar'
import { NativeChatSubagentPrompt } from './NativeChatSubagentPrompt'
import { nativeChatSubagentHandoff } from './native-chat-subagent-handoff'

const NO_MESSAGES: readonly NativeChatMessage[] = []
const NO_SUBAGENT_ROWS: readonly NativeChatSubagentRow[] = []
const NO_TURN_KEYS: readonly (string | undefined)[] = []
const NO_ENTRIES: ReadonlyMap<string, NativeChatSubagentEntry> = new Map()

function words(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Codex's last own message is its reply; a clipped copy of it counts as the same. */
function nativeChatRowsEndWith(rows: readonly NativeChatMessage[], reply: string): boolean {
  const last = rows.findLast((row) => row.role === 'assistant')
  const said = words(
    last?.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n') ?? ''
  )
  const replied = words(reply)
  return said.length > 0 && (said.startsWith(replied) || replied.startsWith(said))
}

/** A settled subagent's reply, drawn as its last message. */
function subagentReplyMessage(
  agentId: string,
  reply: string,
  settledAt: number | undefined
): NativeChatMessage {
  return {
    id: `subagent-reply:${agentId}`,
    role: 'assistant',
    blocks: [{ type: 'text', text: reply }],
    timestamp: settledAt ?? null,
    source: 'transcript'
  }
}

/** What a transcript draws: the conversation in its turns, or one subagent's own rows with none. */
export function useNativeChatSubagentScope({
  view,
  conversation,
  subagentRows,
  roster,
  journalItems,
  journalSubmissions,
  latestTurn,
  isWorking
}: {
  view: NativeChatSubagentView | undefined
  conversation: readonly NativeChatMessage[]
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
  roster: StructuredAgentSubagentRoster | undefined
  journalItems: readonly AgentJournalRenderItem[] | undefined
  journalSubmissions: readonly AgentJournalSubmission[] | undefined
  latestTurn: AgentSessionLatestTurn | null | undefined
  isWorking: boolean
}) {
  const agentId = view?.agentId ?? null
  // The conversation names its subagents only for heads, which need rows; a subagent's bar lists them all.
  const entries = useMemo(
    () =>
      agentId === null && subagentRows.size === 0
        ? NO_ENTRIES
        : nativeChatSubagentEntries(conversation, subagentRows, roster),
    [agentId, conversation, roster, subagentRows]
  )
  const entry = agentId === null ? undefined : entries.get(agentId)
  const settled = entry !== undefined && normalizeSubagentState(entry.state) !== 'working'
  const handoff = useMemo(
    () =>
      agentId === null
        ? null
        : nativeChatSubagentHandoff({ agentId, journalItems, conversation, subagentRows }),
    [agentId, conversation, journalItems, subagentRows]
  )
  const reply = settled ? (handoff?.reply ?? entry.lastMessage ?? null) : null
  const messages = useMemo(() => {
    if (agentId === null) {
      return conversation
    }
    const own = (subagentRows.get(agentId) ?? NO_SUBAGENT_ROWS).map(({ message }) => message)
    return reply === null || nativeChatRowsEndWith(own, reply)
      ? own
      : [...own, subagentReplyMessage(agentId, reply, entry?.settledAt)]
  }, [agentId, conversation, entry?.settledAt, reply, subagentRows])
  const heads = useMemo(
    () => nativeChatSubagentHeads(messages, subagentRows, entries, agentId),
    [agentId, entries, messages, subagentRows]
  )
  // Child edits and PRs count in the conversation's turns, which a subagent's view does not draw.
  const rowsInOrder = useMemo(
    () => (agentId === null ? nativeChatSubagentRowsInOrder(subagentRows) : NO_SUBAGENT_ROWS),
    [agentId, subagentRows]
  )
  const conversationTurns = useNativeChatTurnMembership(
    agentId === null ? messages : NO_MESSAGES,
    journalItems,
    journalSubmissions,
    latestTurn
  )
  const turnRows = useMemo<NativeChatTurnRows>(
    () =>
      agentId === null
        ? conversationTurns
        : { messages, turnKeys: NO_TURN_KEYS, liveTurnKey: undefined },
    [agentId, conversationTurns, messages]
  )
  // A subagent's view pages history only while older history still holds its spawn.
  const pagesHistory = useMemo(
    () =>
      agentId === null ||
      nativeChatSubagentHistoryStep({
        agentId,
        conversation,
        subagentRows,
        roster,
        historyFloor: () => latestAgentSessionContextClearSequence(journalItems ?? [])
      }) === 'page',
    [agentId, conversation, journalItems, roster, subagentRows]
  )
  const open = view?.open
  return {
    agentId,
    open,
    /** Leads a subagent's transcript: what the main agent asked of it. */
    lead:
      agentId !== null && handoff?.prompt ? (
        <NativeChatSubagentPrompt agentId={agentId} prompt={handoff.prompt} />
      ) : null,
    /** Drawn above a subagent's own transcript. */
    bar:
      agentId !== null && open ? (
        <NativeChatSubagentViewBar
          agentId={agentId}
          entries={entries}
          agentsWithRows={subagentRows}
          onOpen={open}
        />
      ) : null,
    messages,
    heads,
    rowsInOrder,
    turnRows,
    /** The conversation's turns; null in a subagent's view. */
    conversationTurns: agentId === null ? turnRows : null,
    pagesHistory,
    // A subagent's rows sit in the conversation's turns, so its view runs on the agent's own state.
    working:
      agentId === null
        ? isWorking
        : entry !== undefined && normalizeSubagentState(entry.state) === 'working'
  }
}
