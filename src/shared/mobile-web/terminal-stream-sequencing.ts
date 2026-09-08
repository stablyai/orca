import type { z } from 'zod'
import { decodedBase64Length } from './base64-decoded-length'
import {
  MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES,
  MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES,
  type MobileWebTerminalOutputEvent,
  type MobileWebTerminalSnapshotChunkEventSchema
} from './terminal-stream-contract'

export type MobileWebTerminalSequenceResult =
  | { ok: true; nextSequence: number }
  | { ok: false; reason: 'duplicate' | 'gap' }

export function validateMobileWebTerminalOutputSequence(
  expectedSequence: number,
  event: MobileWebTerminalOutputEvent
): MobileWebTerminalSequenceResult {
  if (event.startSequence < expectedSequence) {
    return { ok: false, reason: 'duplicate' }
  }
  if (event.startSequence > expectedSequence) {
    return { ok: false, reason: 'gap' }
  }
  return { ok: true, nextSequence: event.endSequence }
}

export function validateMobileWebTerminalSnapshotOffset(
  expectedOffset: number,
  event: z.infer<typeof MobileWebTerminalSnapshotChunkEventSchema>
): MobileWebTerminalSequenceResult {
  if (event.offset < expectedOffset) {
    return { ok: false, reason: 'duplicate' }
  }
  if (event.offset > expectedOffset) {
    return { ok: false, reason: 'gap' }
  }
  return { ok: true, nextSequence: event.offset + decodedBase64Length(event.data) }
}

export function canSendMobileWebTerminalOutput(
  acknowledgedSequence: number,
  sentSequence: number,
  nextBytes: number
): boolean {
  return (
    Number.isSafeInteger(acknowledgedSequence) &&
    Number.isSafeInteger(sentSequence) &&
    Number.isSafeInteger(nextBytes) &&
    acknowledgedSequence >= 0 &&
    sentSequence >= acknowledgedSequence &&
    nextBytes > 0 &&
    nextBytes <= MOBILE_WEB_TERMINAL_MAX_OUTPUT_BATCH_BYTES &&
    sentSequence - acknowledgedSequence + nextBytes <= MOBILE_WEB_TERMINAL_MAX_OUTSTANDING_BYTES
  )
}
