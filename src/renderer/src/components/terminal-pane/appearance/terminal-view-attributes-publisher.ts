/** Publish xterm-equivalent theme reply attributes to main’s hidden-PTY responder; module-global dedup avoids repeated sends from per-pane/attribute-neutral appearance updates. */
import type { ITheme } from '@xterm/xterm'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { TerminalColorSchemeMode } from '../../../../../shared/terminal/protocol/queries/terminal-color-scheme-protocol'
import type { TerminalViewAttributes } from '../../../../../shared/terminal/protocol/queries/terminal-view-attributes'
import type { TerminalOscColorQueryReplyColors } from '../../../../../shared/terminal/protocol/queries/terminal-osc-color-reply'
import {
  composeTerminalViewAttributes,
  terminalThemeColorSchemeReport,
  resolveTerminalViewAttributes
} from '../../../../../shared/terminal-view-attributes-composition'

// Why shared: main pre-loads the same composition from persisted settings before this publishes.
export { composeTerminalViewAttributes, terminalThemeColorSchemeReport }

let lastPublishedSnapshot: string | null = null
let lastPublishedAttributes: TerminalViewAttributes | null = null
type PublishedAttributesListener = (attributes: TerminalViewAttributes) => void
const publishedAttributesListeners = new Set<PublishedAttributesListener>()

/** Hears every published change, starting with the current one if any. */
export function subscribeToPublishedTerminalViewAttributes(
  listener: PublishedAttributesListener
): () => void {
  publishedAttributesListeners.add(listener)
  if (lastPublishedAttributes) {
    listener(lastPublishedAttributes)
  }
  return () => {
    publishedAttributesListeners.delete(listener)
  }
}

/** terminal.create's theme params: the pane's colours, plus this window's palette and cursor for a host that pins
 *  them to the new terminal. Older hosts drop the attributes. */
export function terminalCreateThemeParams(colors: TerminalOscColorQueryReplyColors | undefined): {
  terminalColorQueryReplies?: TerminalOscColorQueryReplyColors
  terminalViewAttributes?: TerminalViewAttributes
} {
  if (!colors) {
    return {}
  }
  return {
    terminalColorQueryReplies: colors,
    ...(lastPublishedAttributes ? { terminalViewAttributes: lastPublishedAttributes } : {})
  }
}

function sendViaPreload(attributes: TerminalViewAttributes): boolean {
  // Preload is absent in web/tests; remote-runtime PTYs never use main’s hidden gate.
  if (typeof window === 'undefined' || !window.api?.pty?.publishTerminalViewAttributes) {
    return false
  }
  window.api.pty.publishTerminalViewAttributes(attributes)
  return true
}

/** Deduplicate app-global snapshots across pane applies and attribute-neutral settings changes. */
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
  lastPublishedAttributes = attributes
  for (const listener of publishedAttributesListeners) {
    listener(attributes)
  }
  return true
}

export function _resetTerminalViewAttributesPublisherForTest(): void {
  lastPublishedSnapshot = null
  lastPublishedAttributes = null
  publishedAttributesListeners.clear()
}
