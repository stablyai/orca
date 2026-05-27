import type { IDisposable, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import {
  extractTerminalFileLinks,
  resolveTerminalFileLink,
  resolveTerminalFileLinkText
} from '@/lib/terminal-links'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { openHttpLink } from '@/lib/http-link-routing'
import { isRemoteRuntimeFileOperation, runtimePathExists } from '@/runtime/runtime-file-client'
import { resolveTerminalFileUrlTarget } from './terminal-file-url-target'
import {
  buildCandidateLogicalLinesForBufferPosition,
  dedupeLogicalLines,
  openFilePathLinkAtBufferPosition
} from './terminal-file-link-hit-testing'
import {
  getTerminalFileContext,
  isHtmlFilePath,
  openDetectedFilePath
} from './terminal-file-open-routing'
import {
  buildHardWrappedPathLogicalLineCandidates,
  buildWrappedLogicalLine,
  rangeForParsedFileLink,
  type WrappedLogicalLine
} from './wrapped-terminal-link-ranges'

export { openDetectedFilePath } from './terminal-file-open-routing'
export { openFilePathLinkAtBufferPosition } from './terminal-file-link-hit-testing'

export type LinkHandlerDeps = {
  worktreeId: string
  worktreePath: string
  startupCwd: string
  managerRef: React.RefObject<PaneManager | null>
  linkProviderDisposablesRef: React.RefObject<Map<number, IDisposable>>
  pathExistsCache: Map<string, boolean>
  runtimeEnvironmentId?: string | null
  getRuntimeEnvironmentIdForPane?: (paneId: number) => string | null
}

type TerminalLinkEvent = Pick<MouseEvent, 'metaKey' | 'ctrlKey'> &
  Partial<Pick<MouseEvent, 'shiftKey' | 'preventDefault' | 'stopPropagation'>>

type ProvidedFileLink = {
  link: ILink
  logicalLine: WrappedLogicalLine
}

function isMacPlatform(): boolean {
  return navigator.userAgent.includes('Mac')
}

export function getTerminalFileOpenHint(): string {
  return isMacPlatform() ? '⌘+click to open' : 'Ctrl+click to open'
}

// Why: .html/.htm files are routed straight into Orca's embedded browser rather
// than the Monaco editor (which would just show the source), matching the
// standalone "Open Preview to the Side" entry point. Advertise the different
// behavior in the hover tooltip so users know a click will render the page.
export function getTerminalHtmlFileOpenHint(): string {
  return isMacPlatform() ? '⌘+click to open in browser' : 'Ctrl+click to open in browser'
}

export function getTerminalUrlOpenHint(): string {
  return isMacPlatform()
    ? '⌘+click to open or ⇧⌘+click for system browser'
    : 'Ctrl+click to open or Shift+Ctrl+click for system browser'
}

export function createFilePathLinkProvider(
  paneId: number,
  deps: LinkHandlerDeps,
  linkTooltip: HTMLElement,
  openLinkHint: string
): ILinkProvider {
  const { startupCwd, managerRef, pathExistsCache, worktreeId, worktreePath } = deps
  return {
    provideLinks: (bufferLineNumber, callback) => {
      const pane = managerRef.current?.getPanes().find((candidate) => candidate.id === paneId)
      if (!pane) {
        callback(undefined)
        return
      }

      const buffer = pane.terminal.buffer.active
      const softWrappedLogicalLine = buildWrappedLogicalLine(buffer, bufferLineNumber)
      if (!softWrappedLogicalLine?.text) {
        callback(undefined)
        return
      }

      const logicalLines = dedupeLogicalLines([
        ...buildHardWrappedPathLogicalLineCandidates(buffer, bufferLineNumber),
        softWrappedLogicalLine
      ])
      if (
        logicalLines.every((logicalLine) => extractTerminalFileLinks(logicalLine.text).length === 0)
      ) {
        callback(undefined)
        return
      }

      void Promise.all(
        logicalLines.flatMap((logicalLine) =>
          extractTerminalFileLinks(logicalLine.text).map(
            async (parsed): Promise<ProvidedFileLink | null> => {
              const resolved = startupCwd ? resolveTerminalFileLink(parsed, startupCwd) : null
              if (!resolved) {
                return null
              }
              const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
              if (!range) {
                return null
              }

              const runtimeEnvironmentId =
                deps.getRuntimeEnvironmentIdForPane?.(paneId) ?? deps.runtimeEnvironmentId ?? null
              const cacheKey = `${runtimeEnvironmentId ?? 'active'}\0${resolved.absolutePath}`
              const cachedExists = pathExistsCache.get(cacheKey)
              const fileContext = getTerminalFileContext(
                worktreeId,
                worktreePath,
                runtimeEnvironmentId
              )
              const exists =
                cachedExists ??
                (fileContext.connectionId ||
                isRemoteRuntimeFileOperation(fileContext, resolved.absolutePath)
                  ? await runtimePathExists(fileContext, resolved.absolutePath)
                  : await window.api.shell.pathExists(resolved.absolutePath))
              pathExistsCache.set(cacheKey, exists)
              if (!exists) {
                return null
              }

              return {
                logicalLine,
                link: {
                  range,
                  text: parsed.displayText,
                  activate: (event) => {
                    if (!isTerminalLinkActivation(event)) {
                      return
                    }
                    openDetectedFilePath(resolved.absolutePath, resolved.line, resolved.column, {
                      worktreeId,
                      worktreePath,
                      runtimeEnvironmentId
                    })
                  },
                  hover: () => {
                    // Why: HTML files get a distinct hint because ⌘/Ctrl+click opens
                    // them rendered in the embedded browser, not as source in the
                    // editor — parallels the "open in system browser" affordance
                    // shown for http URLs.
                    const hint = isHtmlFilePath(resolved.absolutePath)
                      ? getTerminalHtmlFileOpenHint()
                      : openLinkHint
                    linkTooltip.textContent = `${resolved.absolutePath} (${hint})`
                    linkTooltip.style.display = ''
                  },
                  leave: () => {
                    linkTooltip.style.display = 'none'
                  }
                }
              }
            }
          )
        )
      ).then((resolvedLinks) => {
        const latestFingerprints = new Set(
          buildCandidateLogicalLinesForBufferPosition(buffer, bufferLineNumber).map(
            (logicalLine) => logicalLine.fingerprint
          )
        )
        const providedLinks = resolvedLinks.filter(
          (link): link is ProvidedFileLink => link !== null
        )
        const links = providedLinks
          .filter(({ logicalLine }) => latestFingerprints.has(logicalLine.fingerprint))
          .map(({ link }) => link)
        if (providedLinks.length > 0 && links.length === 0) {
          return
        }
        callback(links.length > 0 ? links : undefined)
      })
    }
  }
}

function getTerminalScreenElement(terminal: Terminal): HTMLElement | null {
  return terminal.element?.querySelector('.xterm-screen') ?? null
}

function getBufferPositionForTerminalMouseEvent(
  terminal: Terminal,
  event: MouseEvent
): { x: number; y: number } | null {
  const screenElement = getTerminalScreenElement(terminal)
  if (!screenElement || terminal.cols <= 0 || terminal.rows <= 0) {
    return null
  }

  const rect = screenElement.getBoundingClientRect()
  const relativeX = event.clientX - rect.left
  const relativeY = event.clientY - rect.top
  if (relativeX < 0 || relativeY < 0 || relativeX >= rect.width || relativeY >= rect.height) {
    return null
  }

  const cellWidth = rect.width / terminal.cols
  const cellHeight = rect.height / terminal.rows
  if (cellWidth <= 0 || cellHeight <= 0) {
    return null
  }

  return {
    x: Math.floor(relativeX / cellWidth) + 1,
    y: Math.floor(relativeY / cellHeight) + terminal.buffer.active.viewportY + 1
  }
}

export function installFilePathLinkClickFallback(
  paneId: number,
  terminal: Terminal,
  deps: LinkHandlerDeps
): IDisposable {
  const mouseUpListenerOptions = { capture: true }
  const handleMouseUp = (event: MouseEvent): void => {
    if (event.button !== 0 || !isTerminalLinkActivation(event)) {
      return
    }

    const position = getBufferPositionForTerminalMouseEvent(terminal, event)
    if (!position) {
      return
    }
    const runtimeEnvironmentId =
      deps.getRuntimeEnvironmentIdForPane?.(paneId) ?? deps.runtimeEnvironmentId ?? null
    // Why: xterm can show a wrapped provider link as active while still missing
    // activation for the clicked wrapped row. Always retry file-path hit testing
    // on modifier mouseup; openDetectedFilePath coalesces duplicate opens.
    const opened = openFilePathLinkAtBufferPosition(
      terminal.buffer.active,
      position,
      terminal.cols,
      {
        startupCwd: deps.startupCwd,
        worktreeId: deps.worktreeId,
        worktreePath: deps.worktreePath,
        runtimeEnvironmentId
      }
    )
    if (opened) {
      event.preventDefault()
      event.stopPropagation()
      terminal.clearSelection()
    }
  }

  const terminalElement = terminal.element
  terminalElement?.addEventListener('mouseup', handleMouseUp, mouseUpListenerOptions)
  return {
    dispose: () => {
      terminalElement?.removeEventListener('mouseup', handleMouseUp, mouseUpListenerOptions)
    }
  }
}

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | undefined
): boolean {
  const isMac = isMacPlatform()
  return isMac ? Boolean(event?.metaKey) : Boolean(event?.ctrlKey)
}

export function handleOscLink(
  rawText: string,
  event: TerminalLinkEvent | undefined,
  deps: Pick<LinkHandlerDeps, 'worktreeId' | 'worktreePath'> &
    Partial<Pick<LinkHandlerDeps, 'runtimeEnvironmentId' | 'startupCwd'>>
): void {
  if (!isTerminalLinkActivation(event)) {
    return
  }

  // Why: xterm renders URL links as clickable anchors. Once Orca decides to
  // handle a modified click itself, we must suppress the browser's default
  // anchor navigation or Electron will still launch the system browser.
  // Note: we intentionally do NOT stopPropagation here — xterm's
  // SelectionService listens for mouseup on ownerDocument to clear the
  // pending drag-select state initiated by the mousedown of the same click.
  // Stopping propagation leaves SelectionService's mousemove/mouseup handlers
  // attached, so returning focus to the terminal and moving the mouse (even
  // without holding a button) extends a selection until the next click/Esc.
  event?.preventDefault?.()

  let parsed: URL
  try {
    parsed = new URL(rawText)
  } catch {
    const resolved = resolveTerminalFileLinkText(rawText, deps.startupCwd || deps.worktreePath)
    if (resolved) {
      openDetectedFilePath(resolved.absolutePath, resolved.line, resolved.column, deps)
    }
    return
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    openHttpLink(parsed.toString(), {
      worktreeId: deps.worktreeId,
      forceSystemBrowser: Boolean(event?.shiftKey)
    })
    return
  }

  if (parsed.protocol === 'file:') {
    // Why: file:// URIs should open inside Orca, not via the OS default editor
    // (shell.openPath). We extract the path from the URI and route it through
    // the same openDetectedFilePath logic used for detected file-path links.
    // Only local files are supported — remote hosts (file://remote/…) are rejected
    // because we cannot open them as local paths.
    const resolved = resolveTerminalFileUrlTarget(parsed)
    if (!resolved) {
      return
    }
    openDetectedFilePath(resolved.filePath, resolved.line, resolved.column, deps)
  }
}
