import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react'

export const EMULATOR_ZOOM_LEVELS = [0.0625, 0.125, 0.25, 0.5, 1, 2, 4] as const

export type EmulatorZoomAction = 'in' | 'out' | 'actual' | 'fit' | 'fit-display'

export type EmulatorZoomState = { mode: 'fit' | 'fit-display' } | { mode: 'fixed'; scale: number }

export type EmulatorZoomMetrics = {
  fitScale: number
  fitDisplayScale: number
}

export function resolveEmulatorZoomState(
  state: EmulatorZoomState,
  action: EmulatorZoomAction,
  metrics: EmulatorZoomMetrics
): EmulatorZoomState {
  if (action === 'actual') {
    return { mode: 'fixed', scale: 1 }
  }
  if (action === 'fit' || action === 'fit-display') {
    return { mode: action }
  }

  const currentScale = resolveEffectiveScale(state, metrics)
  if (action === 'in') {
    const next = EMULATOR_ZOOM_LEVELS.find((level) => level > currentScale)
    return next === undefined ? state : { mode: 'fixed', scale: next }
  }

  const previous = EMULATOR_ZOOM_LEVELS.toReversed().find((level) => level < currentScale)
  if (previous === undefined) {
    return state
  }
  if (state.mode !== 'fit' && previous < metrics.fitScale && metrics.fitScale < currentScale) {
    return { mode: 'fit' }
  }
  return { mode: 'fixed', scale: previous }
}

export function resolveEffectiveScale(
  state: EmulatorZoomState,
  metrics: EmulatorZoomMetrics
): number {
  if (state.mode === 'fixed') {
    return state.scale
  }
  return state.mode === 'fit' ? metrics.fitScale : metrics.fitDisplayScale
}

export function resolveEmulatorZoomAvailability(
  state: EmulatorZoomState,
  metrics: EmulatorZoomMetrics | null
): Record<EmulatorZoomAction, boolean> {
  if (!metrics) {
    return { in: false, out: false, actual: false, fit: false, 'fit-display': false }
  }
  const effectiveScale = resolveEffectiveScale(state, metrics)
  const next = EMULATOR_ZOOM_LEVELS.find((level) => level > effectiveScale)
  const previous = EMULATOR_ZOOM_LEVELS.toReversed().find((level) => level < effectiveScale)
  return {
    in: next !== undefined,
    out: previous !== undefined && !(state.mode === 'fit' && previous < metrics.fitScale),
    actual: state.mode !== 'fixed' || state.scale !== 1,
    fit: state.mode !== 'fit',
    'fit-display': state.mode !== 'fit-display'
  }
}

export type EmulatorPaneZoom = {
  state: EmulatorZoomState
  effectiveScale: number
  percentage: number
  availability: Record<EmulatorZoomAction, boolean>
  zoom: (action: EmulatorZoomAction) => void
  setMetrics: Dispatch<SetStateAction<EmulatorZoomMetrics | null>>
}

type DeviceZoomState = {
  deviceId: string | null
  state: EmulatorZoomState
  metrics: EmulatorZoomMetrics | null
}

const initialDeviceZoomState: DeviceZoomState = {
  deviceId: null,
  state: { mode: 'fit' },
  metrics: null
}

export function useEmulatorPaneZoom(deviceId: string | null): EmulatorPaneZoom {
  const [deviceZoom, setDeviceZoom] = useState(initialDeviceZoomState)
  const activeZoom =
    deviceZoom.deviceId === deviceId
      ? deviceZoom
      : { deviceId, state: { mode: 'fit' as const }, metrics: null }
  const setMetrics = useCallback<Dispatch<SetStateAction<EmulatorZoomMetrics | null>>>(
    (value) => {
      setDeviceZoom((current) => {
        const base =
          current.deviceId === deviceId
            ? current
            : { deviceId, state: { mode: 'fit' as const }, metrics: null }
        const metrics = typeof value === 'function' ? value(base.metrics) : value
        if (
          base.deviceId === current.deviceId &&
          base.metrics?.fitScale === metrics?.fitScale &&
          base.metrics?.fitDisplayScale === metrics?.fitDisplayScale
        ) {
          return current
        }
        return { ...base, metrics }
      })
    },
    [deviceId]
  )
  const effectiveScale = activeZoom.metrics
    ? resolveEffectiveScale(activeZoom.state, activeZoom.metrics)
    : 1
  const availability = useMemo(
    () => resolveEmulatorZoomAvailability(activeZoom.state, activeZoom.metrics),
    [activeZoom.metrics, activeZoom.state]
  )
  const zoom = useCallback(
    (action: EmulatorZoomAction) => {
      const metrics = activeZoom.metrics
      if (!metrics || !availability[action]) {
        return
      }
      setDeviceZoom((current) => {
        const base =
          current.deviceId === deviceId
            ? current
            : { deviceId, state: { mode: 'fit' as const }, metrics: null }
        return { ...base, state: resolveEmulatorZoomState(base.state, action, metrics) }
      })
    },
    [activeZoom.metrics, availability, deviceId]
  )

  return {
    state: activeZoom.state,
    effectiveScale,
    percentage: Math.round(effectiveScale * 100),
    availability,
    zoom,
    setMetrics
  }
}
