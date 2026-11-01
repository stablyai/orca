import { z } from 'zod'
import { isPluginJsonObject } from '../manifest/plugin-json-object'
import { PLUGIN_PROTOCOL_VERSION } from './plugin-protocol'

/**
 * Host side of plugin frames (panels and custom editors). A frame has an opaque origin
 * (sandbox="allow-scripts"), so neither side can use origins for trust: the host verifies the
 * sending window and re-validates every envelope; main re-checks capabilities before executing.
 * Frames speak the shared envelope (plugin-protocol.ts) through the shell's `window.orca`.
 */

export const PLUGIN_PANEL_FRAME_NAME_PREFIX = 'orca-plugin-panel:'

/** Envelope names private to frames; plugin code only sees `window.orca`. */
export const FRAME_EVENTS = {
  /** frame → host, payload `{ protocol }`: the shell is listening. */
  ready: 'ready',
  /** host → frame, payload {@link PluginFrameHello}. */
  hello: 'hello',
  /** host → frame, payload {@link PluginFrameTheme}: restyle in place so frame state survives. */
  theme: 'theme',
  ping: 'ping',
  pong: 'pong',
  /** frame → host: a modifier chord, so Orca's save shortcut works inside an editor. */
  editorKeydown: 'editor.keydown',
  /** host → frame: the document, on ready and whenever it changes outside the frame. */
  editorDocument: 'editor.document',
  /** host → frame, payload `PluginPanelPush`: a worker post, an event or a data change. */
  push: 'plugin.push'
} as const

/** Frame-local methods a custom editor handles or calls on the same envelope. */
export const EDITOR_METHODS = {
  /** frame → host: replace the document, `{ baseVersion, content }`. */
  applyEdit: 'editor.applyEdit',
  /** host → frame: post any debounced edit before a save. */
  flush: 'editor.flush'
} as const

export type PluginFrameTheme = { colorScheme: 'light' | 'dark'; tokens: string }

export type PluginFrameHello = {
  protocol: typeof PLUGIN_PROTOCOL_VERSION
  surface: 'panel' | 'editor'
  api: { major: number; minor: number }
  methods: string[]
  theme: PluginFrameTheme
  /** Orca's UI locale (BCP-47); Chromium's `navigator.language` does not follow it. */
  locale?: string
}

/** Per-plugin bridge budgets, enforced host-side. Why 120: a panel loading its storage atoms,
 *  settings and first worker requests makes a burst of small calls. */
export const PANEL_MESSAGE_MAX_BYTES = 64 * 1024
export const PANEL_MESSAGE_RATE_LIMIT = { maxMessages: 120, perMs: 10_000 }

/** Size-only liveness lane: count limits let a panel’s pongs exhaust the budget and starve genuine replies.
 * Pongs also spend the data budget, bounding aggregate cost; walks are capped here. */
export const PANEL_CONTROL_MESSAGE_MAX_BYTES = 1024

/** Missed pongs demote panels; busy-loop detection is valid only while the frame-process gate proves isolation from host renderer. */
export const PANEL_WATCHDOG_PING_INTERVAL_MS = 10_000
export const PANEL_WATCHDOG_PONG_TIMEOUT_MS = 5_000

export const panelSessionTokenSchema = z.string().min(32).max(128)

/** Host-issued opaque sessions identify approved frames; plugin callers never supply their own identity. */
export const panelActionCallSchema = z
  .object({
    sessionToken: panelSessionTokenSchema,
    action: z.string().min(1),
    params: z.unknown().optional()
  })
  .strict()

export type PluginPanelActionCall = z.infer<typeof panelActionCallSchema>

/**
 * Where a desktop frame loads as an isolated `<webview>` guest (plugin-frame-guest.ts). `dev`: a
 * development folder's, whose URL changes on every save (components panels hot reload then).
 */
export type PluginFrameGuest = { partition: string; url: string; dev?: true }

export type PluginFrameEntry = {
  html: string
  /** Authorizes this frame's host calls; main binds it to the plugin and contribution. */
  sessionToken: string
  /** Desktop IPC only: browser clients never get one and keep the srcdoc iframe. */
  guest?: PluginFrameGuest
  /** A declarative panel: the guest runs a module and Orca renders its tree; `html` is empty. */
  ui?: 'components'
}

/** Pong fast path without parse-issue allocations (~90x accepted cost), bounding near-miss spam cost. */
export function readPanelPongId(data: unknown): number | null {
  if (
    !isPluginJsonObject(data) ||
    data.orca !== PLUGIN_PROTOCOL_VERSION ||
    data.kind !== 'evt' ||
    data.event !== FRAME_EVENTS.pong
  ) {
    return null
  }
  // Safe integers only; broader integers admit ping IDs the watchdog could not issue.
  return Number.isSafeInteger(data.payload) && Number(data.payload) >= 0
    ? Number(data.payload)
    : null
}
