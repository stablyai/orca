import { isValidHostTerminalTabId } from './terminal-tab-id'

const MAX_SURFACE_TAB_ID_LENGTH = 512

/**
 * The id of the tab that shows a structured chat, as the host records it. A host tab id: it
 * prefixes every pane key built for the chat, and a web-surface id would decode as another tab.
 */
export function isAgentSessionSurfaceTabId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SURFACE_TAB_ID_LENGTH &&
    isValidHostTerminalTabId(value)
  )
}
