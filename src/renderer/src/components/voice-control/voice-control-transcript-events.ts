/**
 * Classifies server events on the renderer's `oai-events` data channel down to completed
 * transcript lines. Deltas are ignored — only the final per-item transcripts are shown.
 */

export type VoiceControlTranscriptLine = {
  speaker: 'user' | 'coordinator'
  text: string
}

const USER_TRANSCRIPT_EVENT = 'conversation.item.input_audio_transcription.completed'
const COORDINATOR_TRANSCRIPT_EVENT = 'response.output_audio_transcript.done'
const RESPONSE_SETTLED_EVENT = 'response.done'
const INPUT_AUDIO_COMMITTED_EVENT = 'input_audio_buffer.committed'

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * response.done ends a turn however it ended — answered, cancelled by a barge-in, or
 * failed — so it is the one signal that always retires the pill's tool narration. (A
 * cancelled answer never produces a transcript line to clear on.)
 */
export function isResponseSettledEvent(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === RESPONSE_SETTLED_EVENT
  )
}

/**
 * server_vad commits the input buffer exactly when it holds a complete user turn — the
 * voice-activity gate's normal close signal.
 */
export function isInputAudioCommittedEvent(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === INPUT_AUDIO_COMMITTED_EVENT
  )
}

export function classifyControlTranscriptEvent(event: unknown): VoiceControlTranscriptLine | null {
  if (typeof event !== 'object' || event === null) {
    return null
  }
  const type = 'type' in event ? readString(event.type) : null
  const transcript = 'transcript' in event ? readString(event.transcript) : null
  if (transcript === null || transcript.trim().length === 0) {
    return null
  }
  if (type === USER_TRANSCRIPT_EVENT) {
    return { speaker: 'user', text: transcript }
  }
  if (type === COORDINATOR_TRANSCRIPT_EVENT) {
    return { speaker: 'coordinator', text: transcript }
  }
  return null
}
