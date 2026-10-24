// Contract between the Desktop App pane (renderer) and the native window bridge (main).
// Coordinates are window-relative points (same space as `orca computer click --x/--y`).

type DesktopAppWindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type DesktopAppWindow = {
  windowId: number
  pid: number
  appName: string
  bundleId: string | null
  title: string
  bounds: DesktopAppWindowBounds
}

export type DesktopAppTarget = {
  windowId: number
  pid: number
}

export type DesktopAppInput =
  | {
      kind: 'click'
      x: number
      y: number
      button: 'left' | 'right'
      // One press per input; this is its position in a double or triple click (mouseup detail).
      clickCount: number
    }
  | { kind: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'text'; text: string }
  // `key` uses the computer-use key grammar, e.g. "return", "cmd+a", "shift+tab".
  | { kind: 'key'; key: string }

export type DesktopAppInputResult = {
  // `accessibility` = AX action on the element under the point; `synthetic` = event posted to the pid.
  path: 'accessibility' | 'synthetic'
}

export type DesktopAppCaptureSource = {
  // Electron desktopCapturer id (`window:<native window id>:0`) armed for the next getDisplayMedia call.
  sourceId: string
}
