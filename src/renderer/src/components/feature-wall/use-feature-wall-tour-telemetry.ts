import { useCallback, useEffect, useRef } from 'react'
import { FEATURE_WALL_MAX_DWELL_MS } from '../../../../shared/feature-wall-telemetry'
import type { FeatureWallExitAction } from '../../../../shared/feature-wall-tour-depth'
import type { FeatureWallTourDepthSummary } from '../../../../shared/feature-wall-tour-depth'
import type {
  EventProps,
  FeatureWallOpenSourceTelemetry
} from '../../../../shared/telemetry-events'
import { track } from '@/lib/telemetry'

export type FeatureWallTourTelemetryState = {
  open: boolean
  openedAtMs: number
  exitAction: FeatureWallExitAction
}

export function createFeatureWallTourTelemetryState(): FeatureWallTourTelemetryState {
  return {
    open: false,
    openedAtMs: 0,
    exitAction: 'dismissed'
  }
}

export function openFeatureWallTourTelemetrySession(
  state: FeatureWallTourTelemetryState,
  nowMs: number
): boolean {
  if (state.open) {
    return false
  }
  state.open = true
  state.openedAtMs = nowMs
  state.exitAction = 'dismissed'
  return true
}

export function buildFeatureWallClosedTelemetry(
  state: FeatureWallTourTelemetryState,
  nowMs: number,
  source: FeatureWallOpenSourceTelemetry,
  depthSummary: FeatureWallTourDepthSummary
): EventProps<'feature_wall_closed'> | null {
  if (!state.open) {
    return null
  }
  const dwellMs = Math.min(
    FEATURE_WALL_MAX_DWELL_MS,
    Math.max(0, Math.round(nowMs - state.openedAtMs))
  )
  state.open = false
  return {
    dwell_ms: dwellMs,
    source,
    exit_action: state.exitAction,
    ...(depthSummary.furthest_step ? { furthest_step: depthSummary.furthest_step } : {}),
    ...(depthSummary.last_group_id ? { last_group_id: depthSummary.last_group_id } : {}),
    visited_workflow_count: depthSummary.visited_workflow_count,
    visited_substep_count: depthSummary.visited_substep_count,
    completed_workflow_count: depthSummary.completed_workflow_count,
    completed_substep_count: depthSummary.completed_substep_count
  }
}

export function markFeatureWallTourExitAction(
  state: FeatureWallTourTelemetryState,
  exitAction: FeatureWallExitAction
): void {
  state.exitAction = exitAction
}

export function useFeatureWallTourTelemetry(args: {
  isOpen: boolean
  source: FeatureWallOpenSourceTelemetry
  getDepthSummary: () => FeatureWallTourDepthSummary
}): { markExitAction: (exitAction: FeatureWallExitAction) => void } {
  const { isOpen, source, getDepthSummary } = args
  const telemetryRef = useRef<FeatureWallTourTelemetryState>(createFeatureWallTourTelemetryState())
  const sourceRef = useRef(source)
  const getDepthSummaryRef = useRef(getDepthSummary)
  // Why: close telemetry may emit from stable callbacks; keep the payload
  // inputs current before open/close Effects or unmount cleanup can run.
  sourceRef.current = source
  getDepthSummaryRef.current = getDepthSummary

  const emitCloseTelemetry = useCallback(() => {
    const payload = buildFeatureWallClosedTelemetry(
      telemetryRef.current,
      performance.now(),
      sourceRef.current,
      getDepthSummaryRef.current()
    )
    if (payload) {
      track('feature_wall_closed', payload)
    }
  }, [])

  const markExitAction = useCallback((exitAction: FeatureWallExitAction): void => {
    markFeatureWallTourExitAction(telemetryRef.current, exitAction)
  }, [])

  useEffect(() => {
    if (!isOpen) {
      emitCloseTelemetry()
      return undefined
    }

    if (openFeatureWallTourTelemetrySession(telemetryRef.current, performance.now())) {
      track('feature_wall_opened', { source: sourceRef.current })
    }
    // Why: the telemetry session opens from this Effect, so the same Effect
    // owns close-on-unmount instead of a second cleanup-only Effect.
    return () => emitCloseTelemetry()
  }, [emitCloseTelemetry, isOpen])

  return { markExitAction }
}
