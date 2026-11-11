export type DictationMeterState = {
  level: number
  isSpeaking: boolean
  isClipping: boolean
}

export type DictationMeterAnalyzerState = DictationMeterState & {
  peak: number
  lastUpdatedAt: number
  noiseFloor: number
  smoothedLevel: number
  clippingUntil: number
  /** The `now` of the last chunk measured as speech; 0 until then. */
  lastSpeechAt: number
}

export const DEFAULT_DICTATION_METER: DictationMeterState = {
  level: 0,
  isSpeaking: false,
  isClipping: false
}

// Desktop and phone both feed the analyzer one window this long; its smoothing is tuned to it.
export const DICTATION_METER_WINDOW_MS = 50

const CLIPPING_THRESHOLD = 0.98
const CLIPPING_HOLD_MS = 500

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function createDictationMeterAnalyzerState(): DictationMeterAnalyzerState {
  return {
    ...DEFAULT_DICTATION_METER,
    peak: 0,
    lastUpdatedAt: 0,
    noiseFloor: 0.008,
    smoothedLevel: 0,
    clippingUntil: Number.NEGATIVE_INFINITY,
    lastSpeechAt: 0
  }
}

export type DictationAudioLevel = {
  rms: number
  peak: number
}

export function measureDictationAudioChunk(samples: Float32Array): DictationAudioLevel {
  if (samples.length === 0) {
    return { rms: 0, peak: 0 }
  }

  let sumSquares = 0
  let peak = 0
  for (const sample of samples) {
    const absoluteSample = Math.abs(sample)
    sumSquares += sample * sample
    peak = Math.max(peak, absoluteSample)
  }
  return {
    rms: Math.sqrt(sumSquares / samples.length),
    peak: clamp(peak, 0, 1)
  }
}

export function analyzeDictationAudioChunk(
  samples: Float32Array,
  now: number,
  previous: DictationMeterAnalyzerState
): DictationMeterAnalyzerState {
  return analyzeDictationAudioLevel(measureDictationAudioChunk(samples), now, previous)
}

export function analyzeDictationAudioLevel(
  { rms, peak }: DictationAudioLevel,
  now: number,
  previous: DictationMeterAnalyzerState
): DictationMeterAnalyzerState {
  const noiseFloor = Math.max(
    0.004,
    previous.noiseFloor * 0.96 + Math.min(rms, previous.noiseFloor * 2) * 0.04
  )
  const rawLevel = clamp((rms - noiseFloor) / 0.16, 0, 1)
  const smoothing = rawLevel > previous.smoothedLevel ? 0.58 : 0.2
  const smoothedLevel = previous.smoothedLevel + (rawLevel - previous.smoothedLevel) * smoothing
  const clippingUntil = peak >= CLIPPING_THRESHOLD ? now + CLIPPING_HOLD_MS : previous.clippingUntil
  const isSpeaking = smoothedLevel >= 0.1 || peak >= 0.18

  return {
    level: smoothedLevel,
    peak,
    isSpeaking,
    isClipping: now <= clippingUntil,
    lastUpdatedAt: now,
    noiseFloor,
    smoothedLevel,
    clippingUntil,
    lastSpeechAt: isSpeaking ? now : previous.lastSpeechAt
  }
}

export function toPublicDictationMeterState(
  state: DictationMeterAnalyzerState
): DictationMeterState {
  return {
    level: Math.round(state.level * 100) / 100,
    isSpeaking: state.isSpeaking,
    isClipping: state.isClipping
  }
}

export function dictationMeterStatesEqual(
  left: DictationMeterState,
  right: DictationMeterState
): boolean {
  return (
    left.level === right.level &&
    left.isSpeaking === right.isSpeaking &&
    left.isClipping === right.isClipping
  )
}

// Desktop and phone draw the same nine dots so the meter looks alike in both apps.
export const DICTATION_GRAPES = [
  { base: 0.64, response: 0.45, lift: 1 },
  { base: 0.76, response: 0.75, lift: -1 },
  { base: 0.9, response: 1, lift: 1 },
  { base: 1, response: 1.25, lift: -1 },
  { base: 0.86, response: 0.9, lift: 1 },
  { base: 0.72, response: 1.1, lift: -1 },
  { base: 0.82, response: 0.7, lift: 1 },
  { base: 0.68, response: 0.55, lift: -1 },
  { base: 0.58, response: 0.35, lift: 1 }
] as const
