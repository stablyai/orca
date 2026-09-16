import type { GlobalSettings } from '../../../shared/types'

type BlankTerminalStartupSettings = Pick<GlobalSettings, 'blankTerminalStartupCommand'>

export type BlankTerminalStartupStore = {
  settings?: BlankTerminalStartupSettings | null
  queueTabStartupCommand: (tabId: string, startup: { command: string }) => void
}

export function resolveBlankTerminalStartupCommand(
  settings: BlankTerminalStartupSettings | null | undefined
): string | null {
  const command = settings?.blankTerminalStartupCommand?.trim()
  return command ? command : null
}

/**
 * Queue the user's blank-terminal startup command on a freshly created,
 * agent-less tab. Callers that launch an agent or adopt an existing PTY must
 * not call this: the command is meant for the plain shell the user just opened.
 */
export function queueBlankTerminalStartupCommand(
  store: BlankTerminalStartupStore,
  tabId: string
): boolean {
  const command = resolveBlankTerminalStartupCommand(store.settings)
  if (!command) {
    return false
  }
  store.queueTabStartupCommand(tabId, { command })
  return true
}
