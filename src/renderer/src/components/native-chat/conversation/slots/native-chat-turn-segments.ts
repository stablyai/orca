import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-status'
import type { NativeChatTurnFoldRow } from '../../../../../../shared/native-chat/transcript/folding/native-chat-turn-fold'
import { nativeChatTurnBarRows } from '../../../../../../shared/native-chat/transcript/turns/native-chat-turn-grouping'

/** A turn bar's status; `continued` marks the bar of a stretch after the person's message mid-turn. */
export type NativeChatBarStatus = NativeChatTurnStatus & { continued?: true }

/** A turn the person wrote into mid-turn, cut at each of their messages. Its own bar keeps the whole
 *  turn once settled (the first stretch while it runs); each message carries the bar of the stretch
 *  after it, which folds and opens on its own. */
export type NativeChatTurnSegments = {
  /** Bars by the row they draw at: under each of the person's messages, and the turn's own bar
   *  while it runs. Rows absent here keep the turn's usual bar. */
  bars: ReadonlyMap<number, NativeChatBarStatus>
  /** The turn's own bar drawn above a row that also carries its stretch's bar: the turn's first
   *  loaded row is the person's mid-turn message (its opener not loaded). */
  leadBars: ReadonlyMap<number, NativeChatTurnStatus>
  /** The fold a stretch's bar opens, by the row it draws at. */
  barFoldKeys: ReadonlyMap<number, string>
  /** Rows that fold with their stretch rather than the whole turn, by index. */
  foldKeys: ReadonlyMap<number, string>
  /** Running turns: work before this row index folds as if settled. */
  foldsBefore: ReadonlyMap<string, number>
}

export const NO_NATIVE_CHAT_TURN_SEGMENTS: NativeChatTurnSegments = {
  bars: new Map(),
  leadBars: new Map(),
  barFoldKeys: new Map(),
  foldKeys: new Map(),
  foldsBefore: new Map()
}

/** A message the person sent into the turn, drawn as their own bubble. Another agent's mail, card
 *  answers and Orca's own notices are work inside the turn (`endsAnswer`). */
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

/** The fold of the stretch after the person's message `messageId` in `turnKey`. */
export function nativeChatTurnSegmentKey(turnKey: string, messageId: string): string {
  return `${turnKey}:after:${messageId}`
}

const wholeSeconds = (from: number, to: number): number =>
  Math.floor((Math.max(from, to) - from) / 1000)

/** What decides a transcript's turn bars. */
export type NativeChatTurnBarsInput = {
  messages: readonly NativeChatMessage[]
  turnKeys: readonly (string | undefined)[]
  foldRows: readonly NativeChatTurnFoldRow[]
  liveTurnKey: string | undefined
  turnStatuses: {
    active: NativeChatTurnStatus | null
    completedByTurn: Readonly<Record<string, NativeChatTurnStatus>>
  }
  /** Where each turn's bar draws (`nativeChatTurnBarRows`). */
  bars: ReadonlyMap<string, { index: number; above: boolean }>
  /** What the transcript leaves out: quiet turns and their rows. */
  quiet: { rows: ReadonlySet<number>; turns: ReadonlySet<string> }
  /** A bot's intro turn, which draws no bar. */
  introTurn: string | undefined
}

/** The bars a transcript row draws: its turn's own bar at the turn's first row, unless a stretch's
 *  bar takes that row (`segments`), and the fold its bar opens when that is a stretch's. */
export function nativeChatRowBars(
  index: number,
  { turnKeys, bars, introTurn, quiet, liveTurnKey, turnStatuses }: NativeChatTurnBarsInput,
  segments: NativeChatTurnSegments
): {
  status: NativeChatBarStatus | undefined
  statusAbove: boolean
  leadStatus: NativeChatTurnStatus | undefined
  foldKey: string | undefined
} {
  const turnKey = turnKeys[index]
  const bar = turnKey === undefined || turnKey === introTurn ? undefined : bars.get(turnKey)
  const status =
    segments.bars.get(index) ??
    (turnKey === undefined || bar?.index !== index || quiet.turns.has(turnKey)
      ? undefined
      : turnKey === liveTurnKey
        ? (turnStatuses.active ?? undefined)
        : (turnStatuses.completedByTurn[turnKey] ?? undefined))
  const leadStatus = segments.leadBars.get(index)
  return {
    status,
    // Provider-opened turns, or turns whose opener isn't loaded, draw their bar above their first row.
    statusAbove: !leadStatus && bar?.above === true && bar.index === index && status !== undefined,
    leadStatus,
    foldKey: segments.barFoldKeys.get(index)
  }
}

export function nativeChatTurnSegments({
  messages,
  turnKeys,
  foldRows,
  liveTurnKey,
  turnStatuses,
  bars: turnBars,
  quiet,
  introTurn
}: NativeChatTurnBarsInput): NativeChatTurnSegments {
  const cuts = new Map<string, number[]>()
  for (const [index, message] of messages.entries()) {
    const turnKey = turnKeys[index]
    const bar = turnKey === undefined ? undefined : turnBars.get(turnKey)
    if (
      bar === undefined ||
      turnKey === introTurn ||
      quiet.turns.has(turnKey!) ||
      quiet.rows.has(index) ||
      // The turn's own first row opens it, unless its opener isn't loaded (its bar draws above).
      index < bar.index + (bar.above ? 0 : 1) ||
      !isPersonsMessage(message, foldRows[index]!)
    ) {
      continue
    }
    const turnCuts = cuts.get(turnKey!)
    if (turnCuts) {
      turnCuts.push(index)
    } else {
      cuts.set(turnKey!, [index])
    }
  }
  if (cuts.size === 0) {
    return NO_NATIVE_CHAT_TURN_SEGMENTS
  }
  const segments = {
    bars: new Map<number, NativeChatBarStatus>(),
    leadBars: new Map<number, NativeChatTurnStatus>(),
    barFoldKeys: new Map<number, string>(),
    foldKeys: new Map<number, string>(),
    foldsBefore: new Map<string, number>()
  }
  const cutTurns = new Map<string, { at: number[]; keys: string[] }>()
  for (const [turnKey, at] of cuts) {
    const status =
      turnKey === liveTurnKey ? turnStatuses.active : turnStatuses.completedByTurn[turnKey]
    if (!status || status.startedAt === null) {
      continue
    }
    const running = status.workedSeconds === null
    const barIndex = turnBars.get(turnKey)!.index
    const times = at.map((index) => messages[index]!.timestamp!)
    // While running, the turn's own bar times its first stretch; settled, it keeps the whole turn.
    const ownBar: NativeChatTurnStatus = running
      ? {
          startedAt: status.startedAt,
          thinking: false,
          workedSeconds: wholeSeconds(status.startedAt, times[0]!)
        }
      : status
    if (at[0] === barIndex) {
      segments.leadBars.set(barIndex, ownBar)
    } else if (running) {
      segments.bars.set(barIndex, ownBar)
    }
    const turnEnd = running ? null : status.startedAt + status.workedSeconds! * 1000
    // Clocks of different machines can disagree; a stretch never runs backwards.
    let startedAt = Math.max(status.startedAt, times[0]!)
    const keys: string[] = []
    at.forEach((index, cut) => {
      const endedAt = times[cut + 1] ?? turnEnd
      segments.bars.set(
        index,
        endedAt === null
          ? { ...status, startedAt }
          : {
              startedAt,
              thinking: false,
              workedSeconds: wholeSeconds(startedAt, endedAt),
              continued: true
            }
      )
      const key = nativeChatTurnSegmentKey(turnKey, messages[index]!.id)
      segments.barFoldKeys.set(index, key)
      keys.push(key)
      startedAt = Math.max(startedAt, endedAt ?? startedAt)
    })
    if (running) {
      segments.foldsBefore.set(turnKey, at.at(-1)!)
    }
    cutTurns.set(turnKey, { at, keys })
  }
  // Each row after a cut folds with the stretch it is in.
  const next = new Map<string, number>()
  for (const [index, turnKey] of turnKeys.entries()) {
    const turn = turnKey === undefined ? undefined : cutTurns.get(turnKey)
    if (!turn) {
      continue
    }
    let cut = next.get(turnKey!) ?? 0
    while (cut < turn.at.length && turn.at[cut]! <= index) {
      cut += 1
    }
    next.set(turnKey!, cut)
    if (cut > 0 && turn.at[cut - 1] !== index) {
      segments.foldKeys.set(index, turn.keys[cut - 1]!)
    }
  }
  return segments
}

/** A transcript's turn bars: where the person's messages cut its turns (`cuts`: false where a
 *  turn's own header draws its status and opens it whole), and each row's bars. */
export function nativeChatTranscriptTurnBars(
  input: Omit<NativeChatTurnBarsInput, 'bars'>,
  cuts: boolean
): {
  segments: NativeChatTurnSegments
  row: (index: number) => ReturnType<typeof nativeChatRowBars>
} {
  const withBars = { ...input, bars: nativeChatTurnBarRows(input.messages, input.turnKeys) }
  const segments = cuts ? nativeChatTurnSegments(withBars) : NO_NATIVE_CHAT_TURN_SEGMENTS
  return { segments, row: (index) => nativeChatRowBars(index, withBars, segments) }
}
