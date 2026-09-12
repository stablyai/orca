import type { IDisposable, Terminal } from '@xterm/xterm'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import type { TerminalLinkActionContext } from './terminal-link-action-request'
import { openFilePathLinkAtBufferPosition } from './terminal-file-link-hit-testing'
import { handleTerminalFileLink } from './terminal-file-link-actions'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'
import { handleOscLink } from './terminal-osc-link-routing'
import { installTerminalLinkTouchGesture } from './terminal-link-touch-gesture'
import {
  findHttpLinkAtTerminalMouseEvent,
  handleTerminalHttpLink,
  type TerminalHttpLinkActionDestinations,
  type TerminalLinkRoutingPreferenceRequester
} from './terminal-url-link-hit-testing'

/**
 * Resolves the OSC 8 destination under a buffer cell, or null when the cell carries none.
 *
 * Same guarded lookup through xterm internals as the mobile WebView, because a hyperlink's
 * label need not contain its URI. Any failure degrades to null so the caller falls back to
 * URL and file-path matching.
 */
function oscLinkAtPosition(terminal: Terminal, position: { x: number; y: number }): string | null {
  try {
    const cell = terminal.buffer.active.getLine(position.y - 1)?.getCell(position.x - 1) as
      | { extended?: { urlId?: number } }
      | undefined
    const core = (
      terminal as unknown as {
        _core?: { _oscLinkService?: { getLinkData: (id: number) => { uri?: string } | undefined } }
      }
    )._core
    return cell?.extended?.urlId
      ? (core?._oscLinkService?.getLinkData(cell.extended.urlId)?.uri ?? null)
      : null
  } catch {
    return null
  }
}

/**
 * Routes a qualified terminal touch tap through the pane's existing link handlers.
 *
 * Why it rebuilds the action context: the recognizer has already ruled out selection and
 * drags and dispatched no PTY mouse input, so the pointer-gesture and PTY-mouse guards that
 * protect the desktop click path would only reject a tap already known to be deliberate.
 * OSC 8, HTTP and file-path lookups run in the same order as a desktop click.
 */
export function installTerminalPaneTouchLinks({
  terminal,
  paneId,
  linkDeps,
  getLinkActionContext,
  getSourceOwner,
  getActionDestinations,
  requestOpenLinksInAppPreference
}: {
  terminal: Terminal
  paneId: number
  linkDeps: LinkHandlerDeps
  getLinkActionContext: () => TerminalLinkActionContext | null
  getSourceOwner: () => HttpLinkSourceOwner
  getActionDestinations: () => TerminalHttpLinkActionDestinations
  requestOpenLinksInAppPreference: TerminalLinkRoutingPreferenceRequester
}): IDisposable {
  return installTerminalLinkTouchGesture(terminal, ({ x, y }) => {
    const context = getLinkActionContext()
    if (!context) {
      return false
    }
    const event = new MouseEvent('click', { clientX: x, clientY: y, button: 0, cancelable: true })
    const position = getTerminalBufferPositionForMouseEvent(terminal, event)
    if (!position) {
      return false
    }
    // The touch recognizer already checked selection/drag; no PTY mouse input was dispatched.
    const linkActionContext: TerminalLinkActionContext = {
      ...context,
      pointerGesture: { canRequestAction: () => true, dispose: () => {} },
      claimPtyMouse: () => true
    }
    const deps = {
      ...linkDeps,
      startupCwd: linkDeps.getPaneLinkCwd?.(paneId) ?? linkDeps.startupCwd,
      runtimeEnvironmentId:
        linkDeps.getRuntimeEnvironmentIdForPane?.(paneId) ?? linkDeps.runtimeEnvironmentId ?? null,
      sourceOwner: getSourceOwner(),
      actionDestinations: getActionDestinations(),
      requestOpenLinksInAppPreference,
      linkActionContext
    }
    const oscLink = oscLinkAtPosition(terminal, position)
    if (oscLink) {
      return handleOscLink(oscLink, event, deps)
    }
    const url = findHttpLinkAtTerminalMouseEvent(terminal, event)
    if (url) {
      return handleTerminalHttpLink(url, event, deps)
    }
    return openFilePathLinkAtBufferPosition(terminal.buffer.active, position, terminal.cols, {
      ...deps,
      activate: (path, line, column) =>
        handleTerminalFileLink(path, line, column, event, deps, linkActionContext)
    })
  })
}
