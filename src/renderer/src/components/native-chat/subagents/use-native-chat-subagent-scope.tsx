import { useEffect, useMemo } from 'react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
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
  nativeChatSubagentChain,
  nativeChatSubagentEntries,
  nativeChatSubagentHeads,
  nativeChatSubagentRowsInOrder
} from './native-chat-subagent-scope'
import {
  nativeChatSubagentEnding,
  nativeChatSubagentEndingMessage,
  type NativeChatSubagentAside
} from './native-chat-subagent-ending'
import { NativeChatSubagentViewBar } from './NativeChatSubagentViewBar'
import { NativeChatSubagentPrompt } from './NativeChatSubagentPrompt'
import { nativeChatSubagentHandoff } from './native-chat-subagent-handoff'

const NO_MESSAGES: readonly NativeChatMessage[] = []
const NO_SUBAGENT_ROWS: readonly NativeChatSubagentRow[] = []
const NO_TURN_KEYS: readonly (string | undefined)[] = []
const NO_ENTRIES: ReadonlyMap<string, NativeChatSubagentEntry> = new Map()
const NO_CHAIN: readonly string[] = []

function asideText(aside: NativeChatSubagentAside, t: Translate): string {
  switch (aside) {
    case 'no-steps':
      return t('components.native-chat.subagents.noSteps', 'No steps yet')
    case 'cleared':
      return t(
        'components.native-chat.subagents.beforeClear',
        'This subagent ran before the chat was cleared'
      )
    case 'stopped':
      return t('components.native-chat.subagents.stoppedBeforeReply', 'Stopped before replying')
    case 'no-reply':
      return t('components.native-chat.subagents.noReply', 'Ended without a reply')
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
  const t = useTranslate()
  const entry = agentId === null ? undefined : entries.get(agentId)
  const chain = useMemo(
    () => (agentId === null ? NO_CHAIN : nativeChatSubagentChain(agentId, subagentRows)),
    [agentId, subagentRows]
  )
  const parentId = chain.at(-2) ?? null
  const noteParent = view?.noteParent
  useEffect(() => {
    noteParent?.(parentId)
  }, [noteParent, parentId])
  const handoff = useMemo(
    () =>
      agentId === null
        ? null
        : nativeChatSubagentHandoff({ agentId, journalItems, conversation, subagentRows }),
    [agentId, conversation, journalItems, subagentRows]
  )
  // A subagent's view pages history only while older history still holds its spawn.
  const history = useMemo(
    () =>
      agentId === null
        ? 'page'
        : nativeChatSubagentHistoryStep({
            agentId,
            conversation,
            subagentRows,
            roster,
            historyFloor: () => latestAgentSessionContextClearSequence(journalItems ?? [])
          }),
    [agentId, conversation, journalItems, roster, subagentRows]
  )
  const messages = useMemo(() => {
    if (agentId === null) {
      return conversation
    }
    const own = (subagentRows.get(agentId) ?? NO_SUBAGENT_ROWS).map(({ message }) => message)
    const ending = nativeChatSubagentEnding({ entry, handoff, rows: own, history })
    return ending === null
      ? own
      : [
          ...own,
          nativeChatSubagentEndingMessage(
            agentId,
            ending,
            ending.kind === 'aside' ? asideText(ending.aside, t) : '',
            entry?.settledAt
          )
        ]
  }, [agentId, conversation, entry, handoff, history, subagentRows, t])
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
          chain={chain}
          entries={entries}
          subagentRows={subagentRows}
          onOpen={open}
        />
      ) : null,
    messages,
    heads,
    rowsInOrder,
    turnRows,
    /** The conversation's turns; null in a subagent's view. */
    conversationTurns: agentId === null ? turnRows : null,
    pagesHistory: history === 'page',
    /** Names the transcript region: the conversation, or the subagent it shows. */
    regionLabel:
      agentId === null
        ? t('components.native-chat.transcriptLabel', 'Conversation')
        : (entry?.label ?? t('components.native-chat.subagents.unnamed', 'Subagent')),
    // A subagent's rows sit in the conversation's turns, so its view runs on the agent's own state.
    working:
      agentId === null
        ? isWorking
        : entry !== undefined && normalizeSubagentState(entry.state) === 'working'
  }
}
