import type { AgentTurnOutcome } from '../../../agent-status/lifecycle/agent-turn-outcome'
import type { HookListenerState } from '../../listener-state'
import { parseJsonObjectString } from '../../interactive-tool'
import { scanFileRegionsBackwardAsync } from '../../reverse-file-region-scan'
import { findLastExtractedTranscriptLineText } from '../../transcript-reader'

/** The pane's current Droid turn, named by its UserPromptSubmit message_id (Droid's turnId). */
export type DroidPaneTurn = {
  turnId: string
  transcriptPath?: string
  stoppedAt?: number
  /** Undefined until the verdict record is read; null means it reported nothing to show. */
  outcome?: AgentTurnOutcome | null
}

const SCAN_LIMITS = { chunkBytes: 64 * 1024, maxScanBytes: 256 * 1024 }
// Why: Droid writes the verdict ~150 ms after its Stop hook; past this it is not coming.
const VERDICT_WAIT_MS = 10_000

type TurnRecord = { kind: 'verdict'; reason: unknown } | { kind: 'turn-start' }

/** Droid's verdict for `turnId`: undefined until written, null when it is not a cancel or failure. */
async function readDroidTurnOutcome(
  transcriptPath: string,
  turnId: string
): Promise<AgentTurnOutcome | null | undefined> {
  const quotedTurnId = JSON.stringify(turnId)
  const found = await scanFileRegionsBackwardAsync<TurnRecord>(
    transcriptPath,
    SCAN_LIMITS,
    (region) =>
      findLastExtractedTranscriptLineText<TurnRecord>(region.toString('utf8'), (line) => {
        const record = line.includes(quotedTurnId) ? parseJsonObjectString(line) : undefined
        if (record?.type === 'agent_turn_outcome' && record.turnId === turnId) {
          return { kind: 'verdict', reason: record.reason }
        }
        // Records before the turn's own prompt belong to earlier turns.
        return record?.type === 'message' && record.id === turnId
          ? { kind: 'turn-start' }
          : undefined
      })
  )
  return found?.kind === 'verdict' ? outcomeOfReason(found.reason) : undefined
}

function outcomeOfReason(reason: unknown): AgentTurnOutcome | null {
  if (reason === 'cancelled') {
    return 'cancellation'
  }
  if (reason === 'prompt_rejected' || (typeof reason === 'string' && reason.startsWith('model_'))) {
    return 'failure'
  }
  return null
}

/** Marks the turn stopped and returns the verdict a transcript poll has already read. */
export function noteDroidTurnStop(
  turn: DroidPaneTurn | undefined,
  transcriptPath: string | undefined,
  now: number
): AgentTurnOutcome | undefined {
  if (!turn || !transcriptPath) {
    return undefined
  }
  turn.stoppedAt ??= now
  turn.transcriptPath = transcriptPath
  return turn.outcome ?? undefined
}

/** Reads a stopped turn's verdict off the main thread; a turn replaced mid-read is left alone. */
export async function refreshDroidTurnOutcome(
  state: HookListenerState,
  paneKey: string
): Promise<void> {
  const turn = state.droidTurnByPaneKey.get(paneKey)
  if (!turn?.transcriptPath || turn.outcome !== undefined) {
    return
  }
  const outcome = await readDroidTurnOutcome(turn.transcriptPath, turn.turnId)
  if (outcome !== undefined && state.droidTurnByPaneKey.get(paneKey) === turn) {
    turn.outcome = outcome
  }
}

/** A stopped turn whose verdict may still land in the transcript. */
export function isDroidTurnOutcomePending(turn: DroidPaneTurn | undefined, now: number): boolean {
  return Boolean(
    turn?.transcriptPath &&
    turn.stoppedAt !== undefined &&
    turn.outcome === undefined &&
    now - turn.stoppedAt < VERDICT_WAIT_MS
  )
}
