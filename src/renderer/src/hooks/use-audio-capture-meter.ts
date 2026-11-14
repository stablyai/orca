import { useCallback, useRef } from 'react'
import {
  DEFAULT_DICTATION_METER,
  analyzeDictationAudioLevel,
  createDictationMeterAnalyzerState,
  dictationMeterStatesEqual,
  toPublicDictationMeterState,
  type DictationAudioLevel,
  type DictationMeterAnalyzerState,
  type DictationMeterState
} from '../../../shared/dictation-audio-meter'

export type DictationMeterPublisher = (meter: DictationMeterState) => void

export function useAudioCaptureMeter(publishMeter?: DictationMeterPublisher) {
  const analyzerRef = useRef<DictationMeterAnalyzerState>(createDictationMeterAnalyzerState())
  const publishedMeterRef = useRef(DEFAULT_DICTATION_METER)

  const resetMeter = useCallback(() => {
    analyzerRef.current = createDictationMeterAnalyzerState()
    publishedMeterRef.current = DEFAULT_DICTATION_METER
    publishMeter?.(DEFAULT_DICTATION_METER)
  }, [publishMeter])

  // The worklet sends one level per 50 ms window, which paces publishing.
  const measureLevel = useCallback(
    (level: DictationAudioLevel) => {
      analyzerRef.current = analyzeDictationAudioLevel(
        level,
        performance.now(),
        analyzerRef.current
      )
      if (document.hidden) {
        return
      }
      const meter = toPublicDictationMeterState(analyzerRef.current)
      if (!dictationMeterStatesEqual(publishedMeterRef.current, meter)) {
        publishedMeterRef.current = meter
        publishMeter?.(meter)
      }
    },
    [publishMeter]
  )

  // On the performance.now() clock measureLevel feeds the analyzer with.
  const getLastSpeechAt = useCallback(() => analyzerRef.current.lastSpeechAt, [])

  return { resetMeter, measureLevel, getLastSpeechAt }
}
