import type { WheelEvent } from 'react'
import type { EmulatorScreenPoint } from './emulator-screen-gesture'

/** Consume only finite wheel input over the screen; normalize browser units for Android scrolling. */
export function sendAndroidWheel(
  event: WheelEvent<HTMLDivElement>,
  deviceId: string,
  point: EmulatorScreenPoint | null,
  dragging: boolean
): void {
  if (!point || !Number.isFinite(event.deltaX) || !Number.isFinite(event.deltaY)) {
    return
  }
  event.preventDefault()
  if (dragging) {
    return
  }
  const units = event.deltaMode === 1 ? 1 / 3 : event.deltaMode === 2 ? 8 : 1 / 100
  window.api.emulator.sendScrcpyScroll({
    deviceId,
    ...point,
    horizontal: -event.deltaX * units,
    vertical: -event.deltaY * units
  })
}
