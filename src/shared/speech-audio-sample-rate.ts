// Why: resampling allocates proportionally to inputRate/outputRate, so absurd rates must be refused up front.
export const MIN_DICTATION_INPUT_SAMPLE_RATE = 8_000
export const MAX_DICTATION_INPUT_SAMPLE_RATE = 192_000
// Why: desktop capture uses the device's native rate, and on-device models resample any of them.
export const MAX_DESKTOP_CAPTURE_SAMPLE_RATE = 768_000

export function isSupportedDictationSampleRate(
  sampleRate: unknown,
  maxSampleRate = MAX_DICTATION_INPUT_SAMPLE_RATE
): sampleRate is number {
  return (
    typeof sampleRate === 'number' &&
    Number.isFinite(sampleRate) &&
    sampleRate >= MIN_DICTATION_INPUT_SAMPLE_RATE &&
    sampleRate <= maxSampleRate
  )
}

export function assertSupportedDictationSampleRate(
  sampleRate: unknown,
  maxSampleRate = MAX_DICTATION_INPUT_SAMPLE_RATE
): asserts sampleRate is number {
  if (!isSupportedDictationSampleRate(sampleRate, maxSampleRate)) {
    throw new Error('Unsupported audio sample rate')
  }
}
