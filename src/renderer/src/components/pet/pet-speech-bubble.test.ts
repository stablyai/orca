import { describe, expect, it } from 'vitest'
import {
  PET_SPEECH_REMINDER_MINUTES_MAX,
  petSpeechForCountChange,
  petSpeechReminderMs,
  petSpeechText
} from './pet-speech-bubble'

describe('petSpeechForCountChange', () => {
  it('speaks when an agent finishes or starts waiting', () => {
    expect(petSpeechForCountChange({ attention: 0, done: 0 }, { attention: 0, done: 1 })).toBe(
      'done'
    )
    expect(petSpeechForCountChange({ attention: 0, done: 0 }, { attention: 1, done: 0 })).toBe(
      'waiting'
    )
  })

  it('prefers waiting when both rise in one update', () => {
    expect(petSpeechForCountChange({ attention: 0, done: 0 }, { attention: 1, done: 1 })).toBe(
      'waiting'
    )
  })

  it('stays quiet when counts hold or fall', () => {
    expect(petSpeechForCountChange({ attention: 1, done: 2 }, { attention: 1, done: 2 })).toBeNull()
    expect(petSpeechForCountChange({ attention: 1, done: 2 }, { attention: 0, done: 1 })).toBeNull()
  })
})

describe('petSpeechReminderMs', () => {
  it('defaults to ten minutes', () => {
    expect(petSpeechReminderMs(undefined)).toBe(10 * 60_000)
  })

  it('treats zero and invalid values as off', () => {
    expect(petSpeechReminderMs(0)).toBeNull()
    expect(petSpeechReminderMs(-5)).toBeNull()
    expect(petSpeechReminderMs(Number.NaN)).toBeNull()
  })

  it('caps the interval', () => {
    expect(petSpeechReminderMs(10_000)).toBe(PET_SPEECH_REMINDER_MINUTES_MAX * 60_000)
  })
})

describe('petSpeechText', () => {
  it('uses custom text and expands every {count}', () => {
    expect(petSpeechText(' {count} done, {count} total ', 'fallback', 3)).toBe('3 done, 3 total')
  })

  it('falls back when custom text is blank', () => {
    expect(petSpeechText('   ', '{count} waiting', 2)).toBe('2 waiting')
    expect(petSpeechText(undefined, 'Done!', 1)).toBe('Done!')
  })
})
