import { resolveTerminalFileLinkText } from '@/lib/terminal-links'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import { resolveTerminalFileUrlTarget } from '../../../../shared/terminal-file-url-target'
import {
  isTerminalLinkActionActivation,
  isTerminalLinkDirectActivation
} from './terminal-link-activation'
import {
  handleTerminalHttpLink,
  type TerminalHttpLinkActionDestinations,
  type TerminalLinkRoutingPreferenceRequester
} from './terminal-url-link-hit-testing'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import type { TerminalLinkActionContext } from './terminal-link-action-request'
import { handleTerminalFileLink } from './terminal-file-link-actions'

type TerminalLinkEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey'> &
  Partial<
    Pick<
      MouseEvent,
      | 'altKey'
      | 'button'
      | 'clientX'
      | 'clientY'
      | 'shiftKey'
      | 'preventDefault'
      | 'stopPropagation'
    >
  >

function isDesktopOscLinkActivation(event: TerminalLinkEvent | undefined): boolean {
  if (!event) {
    return false
  }
  if ('button' in event && event.button !== undefined && event.button !== 0) {
    return false
  }
  // Why: desktop xterm links must not open while the user is just placing the
  // cursor or selecting text. Mobile URL taps use a separate WebView path.
  return isTerminalLinkDirectActivation(event) || isTerminalLinkActionActivation(event)
}

export function handleOscLink(
  rawText: string,
  event: TerminalLinkEvent | undefined,
  deps: Pick<LinkHandlerDeps, 'worktreeId' | 'worktreePath'> &
    Partial<
      Pick<
        LinkHandlerDeps,
        'runtimeEnvironmentId' | 'startupCwd' | 'terminalHomePath' | 'wslDistro'
      >
    > & {
      sourceOwner?: HttpLinkSourceOwner
      requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
      linkActionContext?: TerminalLinkActionContext | null
      actionDestinations?: TerminalHttpLinkActionDestinations
    }
): boolean {
  if (!isDesktopOscLinkActivation(event)) {
    return false
  }
  const finish = (handled: boolean): boolean => {
    if (handled) {
      // Why: prevent anchor navigation without blocking xterm's document-level selection cleanup.
      event?.preventDefault?.()
    }
    return handled
  }

  const openDetectedPathLink = (): boolean => {
    const resolved = resolveTerminalFileLinkText(
      rawText,
      deps.startupCwd || deps.worktreePath,
      deps.terminalHomePath
    )
    if (!resolved) {
      return false
    }
    return finish(
      handleTerminalFileLink(
        resolved.absolutePath,
        resolved.line,
        resolved.column,
        event as MouseEvent,
        deps,
        deps.linkActionContext,
        rawText
      )
    )
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
    return finish(
      handleTerminalHttpLink(parsed.toString(), event as MouseEvent, {
        worktreeId: deps.worktreeId,
        sourceOwner:
          deps.sourceOwner ??
          (deps.runtimeEnvironmentId
            ? { kind: 'runtime', runtimeEnvironmentId: deps.runtimeEnvironmentId }
            : { kind: 'local' }),
        requestOpenLinksInAppPreference: deps.requestOpenLinksInAppPreference,
        linkActionContext: deps.linkActionContext,
        actionDestinations: deps.actionDestinations,
        actionDestination: rawText
      })
    )
  }

  if (parsed.protocol === 'file:') {
    // Why: file:// URIs should open inside Orca, not via the OS default editor
    // (shell.openPath). We extract the path from the URI and route it through
    // the same openDetectedFilePath logic used for detected file-path links.
    // Remote file hosts stay rejected; Windows LAN shares are the
    // exception because their standard URI form is file://server/share/path.
    const allowUncHost =
      navigator.userAgent.includes('Windows') &&
      isWindowsAbsolutePathLike(deps.worktreePath) &&
      !deps.runtimeEnvironmentId
    const resolved = resolveTerminalFileUrlTarget(parsed, { allowUncHost })
    if (!resolved) {
      return false
    }
    return finish(
      handleTerminalFileLink(
        resolved.filePath,
        resolved.line,
        resolved.column,
        event as MouseEvent,
        deps,
        deps.linkActionContext,
        rawText
      )
    )
  }
  return false
}
