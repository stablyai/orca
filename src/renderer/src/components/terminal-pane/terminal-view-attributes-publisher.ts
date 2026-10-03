/**
 * Phase 5 slice 2 (View-attribute bridge): renderer→main
 * `pty:terminalViewAttributes` publication. Composes
 * the reply-relevant slots of the active terminal theme exactly the way
 * xterm's browser ThemeService resolves an ITheme (defaults, cursor blend,
 * 256-entry palette), so main's hidden-PTY responder replies byte-identically
 * to a visible pane's xterm. Deduped module-globally: applyTerminalAppearance
 * runs per pane manager and on every font/opacity tweak, but the attributes
 * are app-global, so identical snapshots publish once.
 */
import type { ITheme } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import {
  terminalViewColorQueryReplyColors,
  type TerminalViewAttributes
} from '../../../../shared/terminal-view-attributes'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import {
  composeTerminalViewAttributes,
  resolveTerminalViewAttributes
} from '../../../../shared/terminal-view-attributes-composition'

// Why shared: main pre-loads the same composition from persisted settings before this publishes.
export { composeTerminalViewAttributes }

let lastPublishedSnapshot: string | null = null
let lastPublishedColors: TerminalOscColorQueryReplyColors | null = null
type PublishedColorsListener = (colors: TerminalOscColorQueryReplyColors) => void
const publishedColorsListeners = new Set<PublishedColorsListener>()

/** Hears the fg/bg of every published change, starting with the current one if any. */
export function subscribeToPublishedTerminalViewColors(
  listener: PublishedColorsListener
): () => void {
  publishedColorsListeners.add(listener)
  if (lastPublishedColors) {
    listener(lastPublishedColors)
  }
  return () => {
    publishedColorsListeners.delete(listener)
  }
}

function sendViaPreload(attributes: TerminalViewAttributes): boolean {
  // Guarded: unit tests and the web client run without the preload bridge
  // (remote-runtime PTYs are never hidden-gate markable anyway).
  if (typeof window === 'undefined' || !window.api?.pty?.publishTerminalViewAttributes) {
    return false
  }
  window.api.pty.publishTerminalViewAttributes(attributes)
  return true
}

/** Publishes the composed app-global attributes, once per actual change:
 *  repeat calls from per-pane appearance applies (and attribute-neutral
 *  tweaks like font size) are deduped against the last published snapshot. */
export function publishTerminalViewAttributes(
  theme: ITheme | null,
  mode: TerminalColorSchemeMode,
  settings: Pick<GlobalSettings, 'terminalCursorStyle' | 'terminalCursorBlink'>,
  send: (attributes: TerminalViewAttributes) => boolean = sendViaPreload
): boolean {
  return publishResolvedTerminalViewAttributes(
    composeTerminalViewAttributes(theme, mode, settings),
    send
  )
}

/** Publishes what saved settings resolve to: the snapshot main pre-loads from the same settings. */
export function publishTerminalViewAttributesFromSettings(
  settings: GlobalSettings,
  systemPrefersDark: boolean,
  send: (attributes: TerminalViewAttributes) => boolean = sendViaPreload
): boolean {
  return publishResolvedTerminalViewAttributes(
    resolveTerminalViewAttributes(settings, systemPrefersDark),
    send
  )
}

function publishResolvedTerminalViewAttributes(
  attributes: TerminalViewAttributes,
  send: (attributes: TerminalViewAttributes) => boolean
): boolean {
  const serialized = JSON.stringify(attributes)
  if (serialized === lastPublishedSnapshot) {
    return false
  }
  if (!send(attributes)) {
    // Not recorded: a later call with a working bridge must still publish.
    return false
  }
  lastPublishedSnapshot = serialized
  const colors = terminalViewColorQueryReplyColors(attributes)
  lastPublishedColors = colors
  for (const listener of publishedColorsListeners) {
    listener(colors)
  }
  return true
}

/** Test seam: reset the dedupe state between tests. */
export function _resetTerminalViewAttributesPublisherForTest(): void {
  lastPublishedSnapshot = null
  lastPublishedColors = null
  publishedColorsListeners.clear()
}
