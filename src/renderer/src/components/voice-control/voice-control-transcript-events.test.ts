import { describe, expect, it } from 'vitest'
import {
  classifyControlTranscriptEvent,
  isInputAudioCommittedEvent,
  isResponseSettledEvent
} from './voice-control-transcript-events'

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

describe('isResponseSettledEvent', () => {
  it('matches response.done however the turn ended', () => {
    expect(isResponseSettledEvent({ type: 'response.done' })).toBe(true)
    expect(isResponseSettledEvent({ type: 'response.done', response: { status: 'cancelled' } })).toBe(
      true
    )
  })

  it('ignores transcript events, garbage, and null', () => {
    expect(
      isResponseSettledEvent({
        type: 'response.output_audio_transcript.done',
        transcript: 'oak is running the tests'
      })
    ).toBe(false)
    expect(
      isResponseSettledEvent({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: "who's running?"
      })
    ).toBe(false)
    expect(isResponseSettledEvent({ type: 'response.done.done' })).toBe(false)
    expect(isResponseSettledEvent({})).toBe(false)
    expect(isResponseSettledEvent('response.done')).toBe(false)
    expect(isResponseSettledEvent(null)).toBe(false)
    expect(isResponseSettledEvent(undefined)).toBe(false)
  })
})

describe('isInputAudioCommittedEvent', () => {
  it('matches input_audio_buffer.committed', () => {
    expect(isInputAudioCommittedEvent({ type: 'input_audio_buffer.committed' })).toBe(true)
  })

  it('ignores other events, garbage, and null', () => {
    expect(isInputAudioCommittedEvent({ type: 'input_audio_buffer.speech_started' })).toBe(false)
    expect(isInputAudioCommittedEvent({ type: 'response.done' })).toBe(false)
    expect(isInputAudioCommittedEvent({})).toBe(false)
    expect(isInputAudioCommittedEvent('input_audio_buffer.committed')).toBe(false)
    expect(isInputAudioCommittedEvent(null)).toBe(false)
    expect(isInputAudioCommittedEvent(undefined)).toBe(false)
  })
})
