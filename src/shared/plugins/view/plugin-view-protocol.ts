/**
 * Main asks the desktop renderer to show a plugin panel or editor (`orca plugin open`) and, for
 * `orca plugin shot`, to report where the drawn panel sits so main can capture that rect. Only
 * renderer state changes: nothing here shows, raises or focuses a window.
 */

import type { PluginDeclarativeNode } from '../declarative/plugin-declarative-catalog'
import type { PluginShotAct, PluginShotActResult } from './plugin-shot-acts'
import type { PluginCommandAliasActionId } from '../contributions/plugin-command-actions'

export const PLUGIN_VIEW_REQUEST_CHANNEL = 'plugins:viewRequest'
export const PLUGIN_VIEW_REPLY_CHANNEL = 'plugins:viewReply'

export type PluginViewColorScheme = 'light' | 'dark'

/** Orca's chrome a plugin draws into: the status bar, or the whole window. */
export type PluginChromeRegion = 'status-bar' | 'window'

export type PluginViewCapture = {
  /** The guest URL's `rev` the drawn panel must come from; null takes whatever is drawn. */
  guestRevision: string | null
  /** Panel width in CSS pixels for this capture only. */
  width?: number
  /** Paint Orca in this mode for this capture only; the setting is not changed. */
  colorScheme?: PluginViewColorScheme
  /** Capture only if the panel is already the open right-sidebar tab; never open or switch. */
  ifShown?: boolean
  /** Run on the drawn components panel, in order, before it is measured. */
  acts?: PluginShotAct[]
  /** Names this capture, so its `end-capture` puts back only what it changed. */
  captureId?: string
  timeoutMs: number
}

/** `shot --editor`: what to change for the capture, and how long to wait for the editor. */
export type PluginViewEditorCapture = {
  colorScheme?: PluginViewColorScheme
  /** The editor's size in CSS pixels for this capture only. */
  width?: number
  height?: number
  /** The file is a temporary copy: its tab and folder workspace go when the capture ends. */
  scratch?: true
  /** `--act --in-place`: the acted tab and its unsaved edits stay when the capture ends. */
  keepOpen?: true
  /** Names this capture's cleanup, so `end-capture` undoes only what this shot changed. */
  captureId: string
  timeoutMs: number
}

export type PluginViewRequestBody =
  | { kind: 'open-panel'; pluginKey: string; panelId: string; capture?: PluginViewCapture }
  | {
      kind: 'open-editor'
      pluginKey: string
      editorId: string
      filePath: string
      /** Other spellings of `filePath` on the host (its real path), to find a workspace showing it. */
      filePathAliases?: string[]
      /** Opened as a folder workspace when no workspace shows the file. */
      fallbackFolder: string
      capture?: PluginViewEditorCapture
    }
  /** `shot --scenario`: draws a validated tree in a detached preview; no plugin panel or guest. */
  | { kind: 'replay-panel'; replay: PluginViewReplay }
  /** `shot --status-bar` / `--window`: measures that part of Orca's own chrome for a capture. */
  | {
      kind: 'capture-chrome'
      region: PluginChromeRegion
      colorScheme?: PluginViewColorScheme
      captureId?: string
    }
  /** Puts back the width and theme a capture changed, and undoes editor capture `captureId`. */
  | { kind: 'end-capture'; captureId?: string }
  /** A plugin worker's `editor.open`: a workspace file, by path inside the workspace. */
  | { kind: 'open-file'; worktreeId: string; relativePath: string }
  /** A plugin worker's `commands.run`: always the built-in action, never a plugin's override. */
  | { kind: 'run-action'; action: PluginCommandAliasActionId }
  /** A plugin worker's `workspace.open` of a folder workspace, which the runtime cannot activate. */
  | { kind: 'open-folder-workspace'; folderWorkspaceId: string }
  /** Opens the calling plugin's declared settings page inside Orca settings. */
  | { kind: 'open-plugin-settings'; pluginKey: string }

export type PluginViewReplay = {
  tree: PluginDeclarativeNode | null
  /** CSS pixels; absent takes the right sidebar's current width. */
  width?: number
  colorScheme?: PluginViewColorScheme
  timeoutMs: number
}

export type PluginViewRequest = PluginViewRequestBody & { requestId: string }

export type PluginViewDrawnPanel = {
  /** CSS pixels in the window's viewport. */
  rect: { x: number; y: number; width: number; height: number }
  ui: 'components' | 'html'
  guestUrl: string | null
  /** An html panel's guest `<webview>`, in the same CSS pixels as `rect`. */
  guestRect?: { x: number; y: number; width: number; height: number }
  /** The panel's own error banner (a components render or load error), if it shows one. */
  issue: string | null
  colorScheme: PluginViewColorScheme
  themeApplied: boolean
  /** False when the wait timed out and the rect shows whatever was drawn by then. */
  settled: boolean
  /** Host calls (`plugin.request` included) still unanswered when it was measured. */
  pendingRequests?: number
  /** One result per requested act. */
  actions?: PluginShotActResult[]
  /** An editor capture: the frame asked for its document (`orca.document.get` or `onDidChange`). */
  subscribed?: boolean
  /** An editor capture's guest, exactly: other tabs of the same editor share its URL. */
  guestContentsId?: number
}

export type PluginViewReply =
  /** `restored`: on `end-capture` after `--act`, whether the panel's atoms were put back. */
  | { requestId: string; ok: true; panel?: PluginViewDrawnPanel; restored?: boolean }
  | { requestId: string; ok: false; code: string; message: string }

/** The renderer could not show the view; `code` is a stable reason callers may branch on. */
export const PLUGIN_VIEW_NO_WORKSPACE_CODE = 'no_workspace'

/** How long an editor frame has, once loaded, to ask for its document before a shot fails. */
export const PLUGIN_EDITOR_SUBSCRIBE_TIMEOUT_MS = 5_000

/** An `ifShown` capture found another tab, a closed sidebar or another view on screen. */
export const PLUGIN_VIEW_NOT_SHOWN_CODE = 'not_shown'
