// Kept apart from the worklet module, which calls registerProcessor and only loads in AudioWorkletGlobalScope.
export const DICTATION_CAPTURE_WORKLET_NAME = 'orca-dictation-capture'

export type DictationCaptureWorkletOptions = {
  outputSampleRate: number
  frameSamples: number
  levelWindowMs: number
}

export type DictationCaptureWorkletMessage =
  | { type: 'frame'; samples: Float32Array }
  | { type: 'level'; rms: number; peak: number }
