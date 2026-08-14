import { resolveTerminalFileLinkText } from '@/lib/terminal-links'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import { resolveTerminalFileUrlTarget } from '../../../../shared/terminal-file-url-target'
import {
  getTerminalFileContext,
  isHtmlFilePath,
  isTerminalFileLinkModifierInverted,
  mapTerminalFilePath,
  shouldOpenTerminalFileWithSystemDefault,
  terminalLinkWslDistro
} from './terminal-file-open-routing'
import { getTerminalFileLinkHoverHint } from './terminal-link-open-hints'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
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

type OscLinkFileDeps = Pick<LinkHandlerDeps, 'worktreeId' | 'worktreePath'> &
  Partial<
    Pick<LinkHandlerDeps, 'runtimeEnvironmentId' | 'startupCwd' | 'terminalHomePath' | 'wslDistro'>
  >

type OscLinkFileTarget = {
  filePath: string
  line: number | null
  column: number | null
}

/**
 * The three OSC 8 target shapes that name a file, in the order they must be tried.
 * `new URL("C:\\path\\file.ts")` succeeds with protocol `c:`, so a Windows path has
 * to be claimed before generic URL parsing.
 */
function resolveOscLinkFileTarget(
  rawText: string,
  deps: OscLinkFileDeps
): OscLinkFileTarget | null {
  const linkCwd = deps.startupCwd || deps.worktreePath
  const resolveAsPath = (): OscLinkFileTarget | null => {
    const resolved = resolveTerminalFileLinkText(rawText, linkCwd, deps.terminalHomePath)
    return resolved
      ? { filePath: resolved.absolutePath, line: resolved.line, column: resolved.column }
      : null
  }

  if (isWindowsAbsolutePathLike(rawText) && isWindowsAbsolutePathLike(linkCwd)) {
    const windowsTarget = resolveAsPath()
    if (windowsTarget) {
      return windowsTarget
    }
  }

  let parsed: URL
  try {
    parsed = new URL(rawText)
  } catch {
    return resolveAsPath()
  }

  if (parsed.protocol !== 'file:') {
    return null
  }
  // Why: file:// URIs open inside Orca, not via the OS default editor. Remote file
  // hosts stay rejected; Windows LAN shares are the exception because their standard
  // URI form is file://server/share/path.
  const allowUncHost =
    navigator.userAgent.includes('Windows') &&
    isWindowsAbsolutePathLike(deps.worktreePath) &&
    !deps.runtimeEnvironmentId
  const resolved = resolveTerminalFileUrlTarget(parsed, { allowUncHost })
  return resolved
    ? { filePath: resolved.filePath, line: resolved.line, column: resolved.column }
    : null
}

/**
 * Why: the OSC 8 hover otherwise describes every target with URL copy, so a file
 * target advertised "system browser" while the click routed it into Orca. Returns
 * null for non-file targets so the caller falls back to the URL hint.
 */
export function getTerminalOscLinkFileHoverHint(
  rawText: string,
  deps: OscLinkFileDeps & { showActions: boolean }
): string | null {
  const target = resolveOscLinkFileTarget(rawText, deps)
  if (!target) {
    return null
  }
  const mappedPath = mapTerminalFilePath(
    target.filePath,
    deps.worktreePath,
    terminalLinkWslDistro(deps.wslDistro, deps.runtimeEnvironmentId)
  )
  const fileContext = getTerminalFileContext(
    deps.worktreeId,
    deps.worktreePath,
    deps.runtimeEnvironmentId
  )
  return getTerminalFileLinkHoverHint({
    canOpenWithSystemDefault: shouldOpenTerminalFileWithSystemDefault(fileContext, mappedPath),
    isWorktreeRoot: resolveKnownWorktreeRootPathLink(mappedPath) !== null,
    isHtmlFile: isHtmlFilePath(mappedPath),
    showActions: deps.showActions,
    modifierInverts: isTerminalFileLinkModifierInverted()
  })
}

export function handleOscLink(
  rawText: string,
  event: TerminalLinkEvent | undefined,
  deps: OscLinkFileDeps & {
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

  let parsed: URL | null = null
  try {
    parsed = new URL(rawText)
  } catch {
    parsed = null
  }

  if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
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

  const fileTarget = resolveOscLinkFileTarget(rawText, deps)
  if (!fileTarget) {
    return false
  }
  return finish(
    handleTerminalFileLink(
      fileTarget.filePath,
      fileTarget.line,
      fileTarget.column,
      event as MouseEvent,
      deps,
      deps.linkActionContext,
      rawText
    )
  )
}
