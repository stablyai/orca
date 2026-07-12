import type { Terminal } from '@xterm/xterm'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import { handleOscLink } from './terminal-osc-link-routing'
import {
  openHttpLinkAtTerminalMouseEvent,
  type TerminalLinkRoutingPreferenceRequester
} from './terminal-url-link-hit-testing'

type TerminalWebLinkClickDeps = Pick<
  LinkHandlerDeps,
  'worktreeId' | 'worktreePath' | 'startupCwd' | 'runtimeEnvironmentId' | 'terminalHomePath'
> & {
  terminal: Terminal | null
  requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
}

export function handleTerminalWebLinkClick(
  url: string,
  event: MouseEvent | undefined,
  deps: TerminalWebLinkClickDeps
): boolean {
  if (!event) {
    return false
  }

  if (
    deps.terminal &&
    openHttpLinkAtTerminalMouseEvent(deps.terminal, event, {
      worktreeId: deps.worktreeId,
      forceSystemBrowser: Boolean(event.shiftKey),
      requestOpenLinksInAppPreference: deps.requestOpenLinksInAppPreference
    })
  ) {
    // Why: WebLinksAddon only knows the physical row; Orca's logical hit-test
    // preserves the complete URL rendered across hard-wrapped TUI rows.
    event.preventDefault()
    deps.terminal.clearSelection()
    return true
  }

  const handled = handleOscLink(url, event, deps)
  if (handled) {
    deps.terminal?.clearSelection()
  }
  return handled
}
