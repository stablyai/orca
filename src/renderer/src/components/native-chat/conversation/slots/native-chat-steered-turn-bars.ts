import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import type { NativeChatTurnFoldRow } from '../../../../../../shared/native-chat/transcript/folding/native-chat-turn-fold'

export type NativeChatSteeredTurnBars = {
  /** Each bar by the row it draws at: the turn's own bar row, then each message the person sent. */
  bars: ReadonlyMap<number, NativeChatTurnStatus>
  /** The live turn's work before the person's newest message folds as if settled. */
  foldsBefore: ReadonlyMap<string, number>
}

/** A message the person sent into the running turn, drawn as their own bubble. Another agent's
 *  mail, card answers and Orca's own notices are work inside the turn (`endsAnswer`). */
function isPersonsMessage(message: NativeChatMessage, row: NativeChatTurnFoldRow): boolean {
  return (
    row.role === 'user' &&
    row.endsAnswer &&
    row.draws &&
    message.timestamp !== null &&
    message.orcaNotice === undefined &&
    message.queued !== true
  )
}

/** A running turn the person wrote into: the live clock moves under their newest message, and
 *  each stretch of work before one of their messages reads as settled, timed up to that message.
 *  Null when they sent nothing into it, which leaves the one live bar where it is. */
export function nativeChatSteeredTurnBars({
  messages,
  turnKeys,
  foldRows,
  liveTurnKey,
  live,
  bars: turnBars,
  quiet
}: {
  messages: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
  foldRows: readonly NativeChatTurnFoldRow[]
  /** The running turn, unless it draws no bar (a bot's intro turn). */
  liveTurnKey: string | undefined
  live: NativeChatTurnStatus | null
  /** Where each turn's bar draws (`nativeChatTurnBarRows`). */
  bars: ReadonlyMap<string, { index: number }>
  /** What the transcript leaves out: quiet turns and their rows. */
  quiet: { rows: ReadonlySet<number>; turns: ReadonlySet<string> }
}): NativeChatSteeredTurnBars | null {
  const barIndex =
    liveTurnKey === undefined || quiet.turns.has(liveTurnKey)
      ? undefined
      : turnBars.get(liveTurnKey)?.index
  if (barIndex === undefined || !live || live.workedSeconds !== null || live.startedAt === null) {
    return null
  }
  const bars = new Map<number, NativeChatTurnStatus>()
  let barAt = barIndex
  let startedAt = live.startedAt
  for (let index = barIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]!
    if (
      turnKeys[index] !== liveTurnKey ||
      quiet.rows.has(index) ||
      !isPersonsMessage(message, foldRows[index]!)
    ) {
      continue
    }
    // Clocks of different machines can disagree; a stretch never runs backwards.
    const endedAt = Math.max(startedAt, message.timestamp!)
    bars.set(barAt, {
      startedAt,
      thinking: false,
      workedSeconds: Math.floor((endedAt - startedAt) / 1000)
    })
    barAt = index
    startedAt = endedAt
  }
  if (barAt === barIndex) {
    return null
  }
  bars.set(barAt, { ...live, startedAt })
  return { bars, foldsBefore: new Map([[liveTurnKey!, barAt]]) }
}
