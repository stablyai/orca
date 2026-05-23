import { useCallback, useEffect, useRef } from 'react'
import { FEATURE_WALL_MAX_DWELL_MS } from '../../../../shared/feature-wall-telemetry'
import type { FeatureWallOpenSourceTelemetry } from '../../../../shared/telemetry-events'
import { track } from '@/lib/telemetry'

export function useFeatureWallTourTelemetry(
  isOpen: boolean,
  source: FeatureWallOpenSourceTelemetry
): void {
  const telemetryRef = useRef<{ open: boolean; openedAtMs: number }>({
    open: false,
    openedAtMs: 0
  })

  const emitCloseTelemetry = useCallback(() => {
    if (!telemetryRef.current.open) {
      return
    }
    const dwellMs = Math.min(
      FEATURE_WALL_MAX_DWELL_MS,
      Math.max(0, Math.round(performance.now() - telemetryRef.current.openedAtMs))
    )
    track('feature_wall_closed', { dwell_ms: dwellMs })
    telemetryRef.current.open = false
  }, [])

  useEffect(() => {
    if (isOpen && !telemetryRef.current.open) {
      telemetryRef.current = { open: true, openedAtMs: performance.now() }
      track('feature_wall_opened', { source })
      return
    }
    if (!isOpen) {
      emitCloseTelemetry()
    }
  }, [emitCloseTelemetry, isOpen, source])

  useEffect(() => {
    return () => emitCloseTelemetry()
  }, [emitCloseTelemetry])
}
