import { describe, expect, it } from 'vitest'
import { dictationStartFailureKind } from './dictation-toasts'

const startError = (detail: string): string =>
  `Error: Error invoking remote method 'speech:startDictation': Error: ${detail}`

describe('dictationStartFailureKind', () => {
  it.each([
    [startError('Model not ready: not-downloaded'), 'settings'],
    [startError('The speech engine stopped unexpectedly. Try again.'), 'settings'],
    ['NotAllowedError: Permission denied', null],
    [startError('Microphone access not granted. Open System Settings.'), null],
    ['Error: dictation_model_busy', null]
  ])('%s → %s', (message, kind) => {
    expect(dictationStartFailureKind(message)).toBe(kind)
  })
})
