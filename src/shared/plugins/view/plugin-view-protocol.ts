/**
 * Main asks the desktop renderer to show a plugin panel or editor (`orca plugin open`) and, for
 * `orca plugin shot`, to report where the drawn panel sits so main can capture that rect. Only
 * renderer state changes: nothing here shows, raises or focuses a window.
 */

export const PLUGIN_VIEW_REQUEST_CHANNEL = 'plugins:viewRequest'
export const PLUGIN_VIEW_REPLY_CHANNEL = 'plugins:viewReply'

export type PluginViewColorScheme = 'light' | 'dark'

export type PluginViewCapture = {
  /** The guest URL's `rev` the drawn panel must come from; null takes whatever is drawn. */
  guestRevision: string | null
  /** Panel width in CSS pixels for this capture only. */
  width?: number
  /** Paint Orca in this mode for this capture only; the setting is not changed. */
  colorScheme?: PluginViewColorScheme
  /** Capture only if the panel is already the open right-sidebar tab; never open or switch. */
  ifShown?: boolean
  timeoutMs: number
}

export type PluginViewRequestBody =
  | { kind: 'open-panel'; pluginKey: string; panelId: string; capture?: PluginViewCapture }
  | { kind: 'open-editor'; pluginKey: string; editorId: string; filePath: string }
  /** Puts back the width and theme a capture changed. */
  | { kind: 'end-capture' }

export type PluginViewRequest = PluginViewRequestBody & { requestId: string }

export type PluginViewDrawnPanel = {
  /** CSS pixels in the window's viewport. */
  rect: { x: number; y: number; width: number; height: number }
  ui: 'components' | 'html'
  guestUrl: string | null
  /** The panel's own error banner (a components render or load error), if it shows one. */
  issue: string | null
  colorScheme: PluginViewColorScheme
  themeApplied: boolean
  /** False when the wait timed out and the rect shows whatever was drawn by then. */
  settled: boolean
}

export type PluginViewReply =
  | { requestId: string; ok: true; panel?: PluginViewDrawnPanel }
  | { requestId: string; ok: false; code: string; message: string }

/** The renderer could not show the view; `code` is a stable reason callers may branch on. */
export const PLUGIN_VIEW_NO_WORKSPACE_CODE = 'no_workspace'

/** An `ifShown` capture found another tab, a closed sidebar or another view on screen. */
export const PLUGIN_VIEW_NOT_SHOWN_CODE = 'not_shown'
