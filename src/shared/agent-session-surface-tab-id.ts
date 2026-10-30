import { isValidHostTerminalTabId } from './terminal-tab-id'

const MAX_SURFACE_TAB_ID_LENGTH = 512

/** Use the host tab ID prefix for pane keys; web-surface IDs would decode as another tab. */
export function isAgentSessionSurfaceTabId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SURFACE_TAB_ID_LENGTH &&
    isValidHostTerminalTabId(value)
  )
}
