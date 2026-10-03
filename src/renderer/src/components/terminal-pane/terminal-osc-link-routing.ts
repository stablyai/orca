import type { IBufferRange, Terminal } from '@xterm/xterm'
import { resolveTerminalFileLinkText } from '@/lib/terminal-links'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import {
  resolveTerminalFileUrlTarget,
  type TerminalFileUrlTarget
} from '../../../../shared/terminal-file-url-target'
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
import { resolveTerminalFileHost } from './terminal-file-open-routing'
import { setHoveredTerminalFileLink } from './terminal-hovered-file-link'
import { createTerminalPathExistenceBatch } from './terminal-path-existence-batch'
import { probeTerminalPathExists } from './terminal-path-exists-cache'

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

type OscFileLinkDeps = Pick<LinkHandlerDeps, 'worktreePath'> &
  Partial<Pick<LinkHandlerDeps, 'runtimeEnvironmentId' | 'startupCwd' | 'terminalHomePath'>>

/** The file an OSC 8 link points at, or null for web links and text that names no file. */
export function resolveOscFileLinkTarget(
  rawText: string,
  deps: OscFileLinkDeps
): TerminalFileUrlTarget | null {
  const cwd = deps.startupCwd || deps.worktreePath
  const detectedPathTarget = (): TerminalFileUrlTarget | null => {
    const resolved = resolveTerminalFileLinkText(rawText, cwd, deps.terminalHomePath)
    return resolved
      ? { filePath: resolved.absolutePath, line: resolved.line, column: resolved.column }
      : null
  }

  // Why: `new URL("C:\\path\\file.ts")` succeeds with protocol `c:`;
  // Windows OSC links need file-path routing before generic URL parsing.
  if (isWindowsAbsolutePathLike(rawText) && isWindowsAbsolutePathLike(cwd)) {
    const target = detectedPathTarget()
    if (target) {
      return target
    }
  }

  let parsed: URL
  try {
    parsed = new URL(rawText)
  } catch {
    return detectedPathTarget()
  }
  if (parsed.protocol !== 'file:') {
    return null
  }
  // Why: remote file hosts stay rejected; Windows LAN shares are the exception
  // because their standard URI form is file://server/share/path.
  const allowUncHost =
    navigator.userAgent.includes('Windows') &&
    isWindowsAbsolutePathLike(deps.worktreePath) &&
    !deps.runtimeEnvironmentId
  return resolveTerminalFileUrlTarget(parsed, { allowUncHost })
}

/** Remembers a hovered OSC 8 file link so the pane's context menu can reveal it. */
export function setHoveredOscFileLink(
  terminal: Terminal,
  rawText: string,
  range: IBufferRange,
  deps: OscFileLinkDeps &
    Pick<LinkHandlerDeps, 'worktreeId' | 'pathExistsCache'> &
    Partial<Pick<LinkHandlerDeps, 'wslDistro'>>
): void {
  const target = resolveOscFileLinkTarget(rawText, deps)
  if (!target) {
    setHoveredTerminalFileLink(terminal, null)
    return
  }
  const { path, fileContext, clientOsCanOpen } = resolveTerminalFileHost(target.filePath, deps)
  // Why: an OSC 8 link is whatever the program printed, so only reveal a file its host has;
  // another host's file is never revealed, so that host is not asked.
  const exists = clientOsCanOpen
    ? probeTerminalPathExists({
        cache: deps.pathExistsCache,
        pathExists: createTerminalPathExistenceBatch(),
        fileContext,
        absolutePath: path,
        runtimeEnvironmentId: deps.runtimeEnvironmentId,
        // Why: programs often print a link before creating its file.
        recheckMissing: true
      })
    : undefined
  setHoveredTerminalFileLink(terminal, { path, range, clientOsCanOpen }, exists)
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

  const fileTarget = resolveOscFileLinkTarget(rawText, deps)
  if (fileTarget) {
    // Why: file links open inside Orca through the same routing as detected paths,
    // not via the OS default editor.
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

  let parsed: URL
  try {
    parsed = new URL(rawText)
  } catch {
    return false
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
  return false
}
