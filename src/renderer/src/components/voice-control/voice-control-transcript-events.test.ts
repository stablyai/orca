import { describe, expect, it } from 'vitest'
import { classifyControlTranscriptEvent } from './voice-control-transcript-events'

describe('classifyControlTranscriptEvent', () => {
  it('reads a completed user transcription', () => {
    expect(
      classifyControlTranscriptEvent({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: "who's running?"
      })
    ).toEqual({ speaker: 'user', text: "who's running?" })
  })

  it('reads a finished coordinator audio transcript', () => {
    expect(
      classifyControlTranscriptEvent({
        type: 'response.output_audio_transcript.done',
        transcript: 'oak is running the tests'
      })
    ).toEqual({ speaker: 'coordinator', text: 'oak is running the tests' })
  })

  it('ignores transcript deltas and unrelated events', () => {
    expect(
      classifyControlTranscriptEvent({
        type: 'response.output_audio_transcript.delta',
        transcript: 'partial'
      })
    ).toBeNull()
    expect(classifyControlTranscriptEvent({ type: 'response.done' })).toBeNull()
  })

  it('drops empty transcripts and non-objects', () => {
    expect(
      classifyControlTranscriptEvent({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: '   '
      })
    ).toBeNull()
    expect(classifyControlTranscriptEvent(null)).toBeNull()
    expect(classifyControlTranscriptEvent('response.output_audio_transcript.done')).toBeNull()
  })
})
