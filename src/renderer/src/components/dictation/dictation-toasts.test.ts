import { describe, expect, it } from 'vitest'
import { dictationStartFailureKind } from './dictation-toasts'

describe('dictationStartFailureKind', () => {
  it.each([
    [
      "Error invoking remote method 'speech:startDictation': Error: Model not ready: missing",
      'settings'
    ],
    [
      "Error invoking remote method 'speech:startDictation': Error: Unknown model: gone",
      'settings'
    ],
    ['Error: voice_model_not_ready:unavailable', 'settings'],
    [
      "Error invoking remote method 'speech:startDictation': Error: The speech engine stopped unexpectedly. Try again.",
      'transcribe'
    ],
    ['NotAllowedError: Permission denied', null],
    [
      "Error invoking remote method 'speech:startDictation': Error: Microphone access not granted. In System Settings…",
      null
    ],
    ['Error: dictation_model_busy', null]
  ])('%s → %s', (message, kind) => {
    expect(dictationStartFailureKind(message)).toBe(kind)
  })
})
