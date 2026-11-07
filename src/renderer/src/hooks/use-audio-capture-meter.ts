import { useCallback, useRef } from 'react'
import {
  DEFAULT_DICTATION_METER,
  analyzeDictationAudioChunk,
  createDictationMeterAnalyzerState,
  dictationMeterStatesEqual,
  toPublicDictationMeterState,
  type DictationMeterAnalyzerState,
  type DictationMeterState
} from '../../../shared/dictation-audio-meter'

const METER_PUBLISH_INTERVAL_MS = 1000 / 15

export type DictationMeterPublisher = (meter: DictationMeterState) => void

export function useAudioCaptureMeter(publishMeter?: DictationMeterPublisher) {
  const analyzerRef = useRef<DictationMeterAnalyzerState>(createDictationMeterAnalyzerState())
  const publishedMeterRef = useRef(DEFAULT_DICTATION_METER)
  const lastPublishedAtRef = useRef(Number.NEGATIVE_INFINITY)

  const resetMeter = useCallback(() => {
    analyzerRef.current = createDictationMeterAnalyzerState()
    publishedMeterRef.current = DEFAULT_DICTATION_METER
    lastPublishedAtRef.current = Number.NEGATIVE_INFINITY
    publishMeter?.(DEFAULT_DICTATION_METER)
  }, [publishMeter])

  const measureChunk = useCallback(
    (samples: Float32Array) => {
      const now = performance.now()
      analyzerRef.current = analyzeDictationAudioChunk(samples, now, analyzerRef.current)
      if (document.hidden || now - lastPublishedAtRef.current < METER_PUBLISH_INTERVAL_MS) {
        return
      }
      lastPublishedAtRef.current = now
      const meter = toPublicDictationMeterState(analyzerRef.current)
      if (!dictationMeterStatesEqual(publishedMeterRef.current, meter)) {
        publishedMeterRef.current = meter
        publishMeter?.(meter)
      }
    },
    [publishMeter]
  )

  // On the performance.now() clock measureChunk feeds the analyzer with.
  const getLastSpeechAt = useCallback(() => analyzerRef.current.lastSpeechAt, [])

  return { resetMeter, measureChunk, getLastSpeechAt }
}
