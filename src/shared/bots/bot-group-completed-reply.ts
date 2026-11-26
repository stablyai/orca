// A member turn's saved reply is the answer its settled room turn draws, so narration before tool
// calls never reaches room history, the sidebar preview or @Name hand-offs.
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import { projectNativeChatTranscriptMessages } from '../native-chat/transcript/native-chat-transcript-projection'
import { createStructuredQuestionProjection } from '../native-chat/transcript/messages/structured-agent-question-projection'
import {
  nativeChatTurnAnswerRows,
  nativeChatTurnFoldRow
} from '../native-chat/transcript/folding/native-chat-turn-fold'
import { projectStructuredOrcaCardItem } from '../structured-automation-saved-projection'

const roomTranscript = createStructuredQuestionProjection(projectStructuredOrcaCardItem)
// Projecting costs ~2.5 µs a row on main: a turn of thousands of tool calls reads only its newest
// rows, where its answer is, so the turn end stays within a frame.
const ANSWER_WINDOW_ROWS = 2048

/** The words of the rows the shared fold rule keeps unfolded. It approximates `BotGroupTurn`,
 *  which also runs display-only passes, and a failure the turn ends on is no reply. */
function botGroupTurnAnswerText(items: readonly AgentJournalRenderItem[]): string {
  const { messages, receipts } = roomTranscript.transcript(items)
  const rows = projectNativeChatTranscriptMessages(messages).filter(
    (message) => message.role !== 'user'
  )
  const answers = nativeChatTurnAnswerRows(
    rows.map((message) => nativeChatTurnFoldRow(message, 'turn', receipts.get(message.id)))
  )
  return rows
    .flatMap((message, index) =>
      answers.has(index) && message.role === 'assistant'
        ? message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
    .join('\n')
}

/** A turn's finished reply (`text` cut for room history, `full` whole) and when it finished; null
 *  until it completes with text. */
export function botGroupCompletedReply(
  items: readonly AgentJournalRenderItem[]
): { text: string; full: string; completedAt: number | undefined } | null {
  const turn = items.find((item) => item.body.kind === 'turn')
  if (turn?.body.kind !== 'turn' || turn.body.state !== 'completed') {
    return null
  }
  const full = botGroupTurnAnswerText(items.slice(-ANSWER_WINDOW_ROWS))
  return full ? { text: full.slice(-16_000), full, completedAt: turn.body.completedAt } : null
}

export function botGroupCompletedText(items: readonly AgentJournalRenderItem[]): string | null {
  return botGroupCompletedReply(items)?.text ?? null
}
