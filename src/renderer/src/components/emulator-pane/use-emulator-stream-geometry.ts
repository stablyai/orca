import { useMemo } from 'react'
import { nativeEmulatorDeviceId } from './use-emulator-native-video'
import { scrcpyDeviceIdFromStreamUrl } from './emulator-scrcpy-stream-url'
import {
  resolveVisualStreamGeometry,
  type StreamSize,
  type EmulatorDeviceVisualOrientation,
  type EmulatorStreamOrientation
} from './emulator-device-frame-layout'

/** Native frames already carry device rotation; avoid applying the visual quarter-turn twice. */
export function useEmulatorStreamGeometry(
  streamSize: StreamSize | null,
  visualOrientation: EmulatorDeviceVisualOrientation,
  reportedOrientation: EmulatorStreamOrientation | null,
  previewUrl: string | undefined
) {
  const nativeId = nativeEmulatorDeviceId(previewUrl)
  const geometry = useMemo(
    () =>
      resolveVisualStreamGeometry(
        streamSize,
        visualOrientation,
        reportedOrientation,
        Boolean(nativeId)
      ),
    [nativeId, reportedOrientation, streamSize, visualOrientation]
  )
  return geometry
}

export function androidDeviceIdFromStreamUrl(url: string | undefined): string | null {
  return nativeEmulatorDeviceId(url) ?? scrcpyDeviceIdFromStreamUrl(url)
}
