import { record, type JsonRecord } from './codex-rollout-jsonl-cursor'

export type CodexTranscriptTurn = {
  turnId?: string
  interrupted: boolean
}

/** The root rollout, rather than a terminal key or painted notice, confirms cancellation. */
export function reconcileCodexTranscriptTurn(
  turn: CodexTranscriptTurn,
  records: readonly JsonRecord[]
): void {
  for (const item of records) {
    if (item.type !== 'event_msg') {
      continue
    }
    const payload = record(item.payload)
    if (!payload) {
      continue
    }
    const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : undefined
    if (payload.type === 'task_started' || payload.type === 'turn_started') {
      turn.turnId = turnId
      turn.interrupted = false
    } else if (!turnId || !turn.turnId || turnId === turn.turnId) {
      if (payload.type === 'turn_aborted' && payload.reason === 'interrupted') {
        turn.interrupted = true
      } else if (payload.type === 'task_complete' || payload.type === 'turn_complete') {
        turn.interrupted = false
      }
    }
  }
}

export function readCodexTranscriptTurnEnd(
  recordValue: JsonRecord
): { turnId: string; end: 'completed' | 'failed' } | undefined {
  if (recordValue.type !== 'event_msg') {
    return undefined
  }
  const payload = record(recordValue.payload)
  const turnId = typeof payload?.turn_id === 'string' ? payload.turn_id.trim() : ''
  if ((payload?.type !== 'task_complete' && payload?.type !== 'turn_complete') || !turnId) {
    return undefined
  }
  return { turnId, end: payload.error == null ? 'completed' : 'failed' }
}
