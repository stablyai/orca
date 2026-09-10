import { useEffect, useMemo } from 'react'
import {
  fitDeviceFrameToPane,
  layoutDeviceFrameAtScreenSize,
  scaleDeviceFrameLayout,
  type DeviceFrameKind,
  type DeviceFrameLayout,
  type PaneSize,
  type StreamSize
} from './emulator-device-frame-layout'
import {
  resolveEffectiveScale,
  type EmulatorZoomMetrics,
  type EmulatorZoomState
} from './emulator-pane-zoom'

type UseEmulatorDeviceFrameLayoutOptions = {
  paneSize: PaneSize | null
  frameKind: DeviceFrameKind
  screenAspectRatio: number
  visualStreamSize: StreamSize | null
  zoomState?: EmulatorZoomState
  onZoomMetrics?: (metrics: EmulatorZoomMetrics | null) => void
}

export function useEmulatorDeviceFrameLayout({
  paneSize,
  frameKind,
  screenAspectRatio,
  visualStreamSize,
  zoomState,
  onZoomMetrics
}: UseEmulatorDeviceFrameLayoutOptions): DeviceFrameLayout | null {
  const naturalFrameLayout = useMemo(
    () => (visualStreamSize ? layoutDeviceFrameAtScreenSize(visualStreamSize, frameKind) : null),
    [frameKind, visualStreamSize]
  )
  const zoomMetrics = useMemo<EmulatorZoomMetrics | null>(() => {
    if (!paneSize || !naturalFrameLayout || !visualStreamSize) {
      return null
    }
    return {
      fitScale: Math.min(
        paneSize.width / naturalFrameLayout.width,
        paneSize.height / naturalFrameLayout.height
      ),
      fitDisplayScale: Math.min(
        paneSize.width / visualStreamSize.width,
        paneSize.height / visualStreamSize.height
      )
    }
  }, [naturalFrameLayout, paneSize, visualStreamSize])

  useEffect(() => {
    onZoomMetrics?.(zoomMetrics)
  }, [onZoomMetrics, zoomMetrics])

  return useMemo(() => {
    if (!naturalFrameLayout || !zoomState || !zoomMetrics) {
      return fitDeviceFrameToPane(paneSize, screenAspectRatio, frameKind)
    }
    return scaleDeviceFrameLayout(naturalFrameLayout, resolveEffectiveScale(zoomState, zoomMetrics))
  }, [frameKind, naturalFrameLayout, paneSize, screenAspectRatio, zoomMetrics, zoomState])
}
