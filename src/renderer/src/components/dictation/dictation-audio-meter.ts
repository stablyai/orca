export type DictationMeterState = {
  level: number
  peak: number
  isSpeaking: boolean
  isSilent: boolean
  isClipping: boolean
  lastUpdatedAt: number
}

export type DictationMeterAnalyzerState = DictationMeterState & {
  noiseFloor: number
  smoothedLevel: number
  lastSpeechAt: number
}

export const DICTATION_METER_PUBLISH_INTERVAL_MS = 33
export const DICTATION_SILENCE_THRESHOLD_MS = 1_000
export const DICTATION_CLIPPING_THRESHOLD = 0.98

export const DEFAULT_DICTATION_METER: DictationMeterState = {
  level: 0,
  peak: 0,
  isSpeaking: false,
  isSilent: true,
  isClipping: false,
  lastUpdatedAt: 0
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export function resetDictationMeterState(): DictationMeterState {
  return { ...DEFAULT_DICTATION_METER }
}

export function createDictationMeterAnalyzerState(): DictationMeterAnalyzerState {
  return {
    ...DEFAULT_DICTATION_METER,
    noiseFloor: 0.01,
    smoothedLevel: 0,
    lastSpeechAt: Number.NEGATIVE_INFINITY
  }
}

export function measureDictationAudioChunk(samples: Float32Array): { rms: number; peak: number } {
  if (samples.length === 0) {
    return { rms: 0, peak: 0 }
  }

  let sumSquares = 0
  let maxAbsSample = 0
  for (const sample of samples) {
    const absSample = Math.abs(sample)
    sumSquares += sample * sample
    if (absSample > maxAbsSample) {
      maxAbsSample = absSample
    }
  }

  return {
    rms: Math.sqrt(sumSquares / samples.length),
    peak: Math.min(1, maxAbsSample)
  }
}

export function analyzeDictationAudioChunk(
  samples: Float32Array,
  now: number,
  previous: DictationMeterAnalyzerState
): DictationMeterAnalyzerState {
  const { rms, peak } = measureDictationAudioChunk(samples)
  const noiseFloor = Math.max(
    0.005,
    previous.noiseFloor * 0.95 + Math.min(rms, previous.noiseFloor * 2) * 0.05
  )
  const rawLevel = clamp((rms - noiseFloor) / 0.18, 0, 1)
  const alpha = rawLevel > previous.smoothedLevel ? 0.55 : 0.18
  const smoothedLevel = previous.smoothedLevel + (rawLevel - previous.smoothedLevel) * alpha
  const isSpeaking = smoothedLevel >= 0.12 || peak >= 0.2
  const lastSpeechAt = isSpeaking ? now : previous.lastSpeechAt
  const isSilent = now - lastSpeechAt >= DICTATION_SILENCE_THRESHOLD_MS

  return {
    level: smoothedLevel,
    peak,
    isSpeaking,
    isSilent,
    isClipping: peak >= DICTATION_CLIPPING_THRESHOLD,
    lastUpdatedAt: now,
    noiseFloor,
    smoothedLevel,
    lastSpeechAt
  }
}

export function toPublicDictationMeterState(
  state: DictationMeterAnalyzerState
): DictationMeterState {
  return {
    level: state.level,
    peak: state.peak,
    isSpeaking: state.isSpeaking,
    isSilent: state.isSilent,
    isClipping: state.isClipping,
    lastUpdatedAt: state.lastUpdatedAt
  }
}

export function truncateDictationTranscript(text: string, maxChars = 80): string {
  if (text.length <= maxChars) {
    return text
  }

  return `…${text.slice(-(maxChars - 1))}`
}
