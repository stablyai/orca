import { resolveTerminalFileLinkText } from '@/lib/terminal-links'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import { resolveTerminalFileUrlTarget } from '../../../../shared/terminal-file-url-target'
import { openDetectedFilePath } from './terminal-file-open-routing'
import { isTerminalLinkActivation } from './terminal-link-activation'
import {
  openTerminalHttpLink,
  type TerminalLinkRoutingPreferenceRequester
} from './terminal-url-link-hit-testing'

type TerminalLinkEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey'> &
  Partial<Pick<MouseEvent, 'button' | 'shiftKey' | 'preventDefault' | 'stopPropagation'>>

function isDesktopOscLinkActivation(event: TerminalLinkEvent | undefined): boolean {
  if (!event) {
    return false
  }
  if ('button' in event && event.button !== undefined && event.button !== 0) {
    return false
  }
  // Why: desktop xterm links must not open while the user is just placing the
  // cursor or selecting text. Mobile URL taps use a separate WebView path.
  return isTerminalLinkActivation(event)
}

export function handleOscLink(
  rawText: string,
  event: TerminalLinkEvent | undefined,
  deps: Pick<LinkHandlerDeps, 'worktreeId' | 'worktreePath'> &
    Partial<Pick<LinkHandlerDeps, 'runtimeEnvironmentId' | 'startupCwd' | 'terminalHomePath'>> & {
      requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
    }
): boolean {
  if (!isDesktopOscLinkActivation(event)) {
    return false
  }
  // Why: xterm renders OSC 8 links as clickable anchors. Orca must suppress
  // default anchor navigation so link-routing settings can choose the target.
  // Note: we intentionally do NOT stopPropagation here — xterm's
  // SelectionService listens for mouseup on ownerDocument to clear the
  // pending drag-select state initiated by the mousedown of the same click.
  // Stopping propagation leaves SelectionService's mousemove/mouseup handlers
  // attached, so returning focus to the terminal and moving the mouse (even
  // without holding a button) extends a selection until the next click/Esc.
  event?.preventDefault?.()

  const openDetectedPathLink = (): boolean => {
    const resolved = resolveTerminalFileLinkText(
      rawText,
      deps.startupCwd || deps.worktreePath,
      deps.terminalHomePath
    )
    if (!resolved) {
      return false
    }
    openDetectedFilePath(resolved.absolutePath, resolved.line, resolved.column, {
      ...deps,
      openWithSystemDefault: Boolean(event?.shiftKey)
    })
    return true
  }

  if (
    isWindowsAbsolutePathLike(rawText) &&
    isWindowsAbsolutePathLike(deps.startupCwd || deps.worktreePath) &&
    openDetectedPathLink()
  ) {
    // Why: `new URL("C:\\path\\file.ts")` succeeds with protocol `c:`;
    // Windows OSC links need file-path routing before generic URL parsing.
    return true
  }

  let parsed: URL
  try {
    parsed = new URL(rawText)
  } catch {
    return openDetectedPathLink()
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    openTerminalHttpLink(parsed.toString(), {
      worktreeId: deps.worktreeId,
      forceSystemBrowser: Boolean(event?.shiftKey),
      requestOpenLinksInAppPreference: deps.requestOpenLinksInAppPreference
    })
    return true
  }

  if (parsed.protocol === 'file:') {
    // Why: file:// URIs should open inside Orca, not via the OS default editor
    // (shell.openPath). We extract the path from the URI and route it through
    // the same openDetectedFilePath logic used for detected file-path links.
    // Remote file hosts stay rejected; Windows local network shares are the
    // exception because their standard URI form is file://server/share/path.
    const allowUncHost =
      navigator.userAgent.includes('Windows') &&
      isWindowsAbsolutePathLike(deps.worktreePath) &&
      !deps.runtimeEnvironmentId
    const resolved = resolveTerminalFileUrlTarget(parsed, { allowUncHost })
    if (!resolved) {
      return false
    }
    openDetectedFilePath(resolved.filePath, resolved.line, resolved.column, {
      ...deps,
      openWithSystemDefault: Boolean(event?.shiftKey)
    })
    return true
  }
  return false
}
