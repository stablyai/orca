import type { EmulatorDeviceVisualOrientation } from './emulator-device-frame-layout'
import type { EmulatorGesturePoint } from './emulator-screen-gesture'

export type EmulatorDeviceFrameProps = {
  previewUrl?: string
  wsUrl?: string
  streamKey?: string
  deviceName?: string
  loading: boolean
  isLive: boolean
  visualOrientation: EmulatorDeviceVisualOrientation
  /** False when backgrounded; parks the stream with the pane's visibility. */
  isActive: boolean
  onTap: (x: number, y: number) => void
  onGesture: (points: EmulatorGesturePoint[]) => void
  onStreamLost?: (retryWithScrcpy?: boolean) => void
}
