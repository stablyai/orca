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

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
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
