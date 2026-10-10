// Main → renderer events from a native terminal surface.
export type NativeTerminalEvent =
  | { surfaceId: number; kind: 'input'; data: string }
  | { surfaceId: number; kind: 'resize'; cols: number; rows: number }
  | { surfaceId: number; kind: 'focus'; focused: boolean }
  | { surfaceId: number; kind: 'title'; title: string }
  | { surfaceId: number; kind: 'openUrl'; url: string }
  | { surfaceId: number; kind: 'bell' }
  // The pointer entered the surface; the page cannot see it under the native view.
  | { surfaceId: number; kind: 'mouseEnter'; buttons: number; windowFocused: boolean }
  // Text a Services menu item returned for the surface, to paste like Edit > Paste.
  | { surfaceId: number; kind: 'pasteText'; text: string }

// [x, y, width, height] in window points where a DOM overlay shows through the native view.
export type NativeTerminalHole = [number, number, number, number]

// [surfaceId, x, y, width, height, visible, holes?] in window points (CSS px × zoom factor).
export type NativeTerminalFrame =
  | [number, number, number, number, number, boolean]
  | [number, number, number, number, number, boolean, NativeTerminalHole[]]

export const NATIVE_TERMINAL_EVENT_CHANNEL = 'nativeTerminal:event'
