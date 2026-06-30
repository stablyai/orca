import type { IDisposable, ILinkProvider, Terminal } from '@xterm/xterm'
import {
  extractTerminalFileLinkCandidates,
  extractTerminalFileLinks,
  resolveTerminalFileLink
} from '@/lib/terminal-links'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { isRemoteRuntimeFileOperation, runtimePathExists } from '@/runtime/runtime-file-client'
import {
  buildCandidateLogicalLinesForBufferPosition,
  dedupeLogicalLines,
  openFilePathLinkAtBufferPosition
} from './terminal-file-link-hit-testing'
import {
  getTerminalFileContext,
  isHtmlFilePath,
  openDetectedFilePath,
  shouldOpenTerminalFileWithSystemDefault
} from './terminal-file-open-routing'
import {
  buildHardWrappedPathLogicalLineCandidates,
  buildWrappedLogicalLine,
  rangeForParsedFileLink
} from './wrapped-terminal-link-ranges'
import {
  getTerminalPathExistsCacheKey,
  readTerminalPathExistsCache,
  writeTerminalPathExistsCache
} from './terminal-path-exists-cache'
import {
  getTerminalHtmlFileOpenHint,
  getTerminalOrcaFileOpenHint,
  getTerminalWorktreePathOpenHint,
  getTerminalFileOpenHint,
  getTerminalUrlOpenHint,
  isMacPlatform
} from './terminal-link-open-hints'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
import { resolveWorkspaceFileByBasename } from './terminal-workspace-file-resolution'
import { preferLongestNonOverlappingLinks } from './terminal-link-overlap-selection'
import type { ProvidedFileLink } from './terminal-provided-file-link'

export { openDetectedFilePath } from './terminal-file-open-routing'
export { openFilePathLinkAtBufferPosition } from './terminal-file-link-hit-testing'
export { getTerminalFileOpenHint, getTerminalHtmlFileOpenHint, getTerminalUrlOpenHint }

export type LinkHandlerDeps = {
  worktreeId: string
  worktreePath: string
  startupCwd: string
  getPaneLinkCwd?: (paneId: number) => string | null
  managerRef: React.RefObject<PaneManager | null>
  linkProviderDisposablesRef: React.RefObject<Map<number, IDisposable>>
  pathExistsCache: Map<string, boolean>
  runtimeEnvironmentId?: string | null
  terminalHomePath?: string | null
  getRuntimeEnvironmentIdForPane?: (paneId: number) => string | null
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
      const logicalLines = dedupeLogicalLines([
        ...buildHardWrappedPathLogicalLineCandidates(buffer, bufferLineNumber),
        ...(softWrappedLogicalLine ? [softWrappedLogicalLine] : [])
      ])
      if (logicalLines.every((logicalLine) => !logicalLine.text)) {
        callback(undefined)
        return
      }

      if (
        logicalLines.every((logicalLine) => extractTerminalFileLinks(logicalLine.text).length === 0)
      ) {
        callback(undefined)
        return
      }

      void Promise.all(
        logicalLines.flatMap((logicalLine) =>
          extractTerminalFileLinkCandidates(logicalLine.text).map(
            async (parsed): Promise<ProvidedFileLink | null> => {
              const paneLinkCwd = deps.getPaneLinkCwd?.(paneId) ?? startupCwd
              const resolved = paneLinkCwd
                ? resolveTerminalFileLink(parsed, paneLinkCwd, deps.terminalHomePath)
                : null
              if (!resolved) {
                return null
              }
              const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
              if (!range) {
                return null
              }

              const runtimeEnvironmentId =
                deps.getRuntimeEnvironmentIdForPane?.(paneId) ?? deps.runtimeEnvironmentId ?? null
              const fileContext = getTerminalFileContext(
                worktreeId,
                worktreePath,
                runtimeEnvironmentId
              )
              const isRemoteRuntimePath = isRemoteRuntimeFileOperation(
                fileContext,
                resolved.absolutePath
              )
              const cacheKey = getTerminalPathExistsCacheKey({
                absolutePath: resolved.absolutePath,
                connectionId: fileContext.connectionId,
                isRemoteRuntimePath,
                runtimeEnvironmentId
              })
              const worktreeRootLink = resolveKnownWorktreeRootPathLink(resolved.absolutePath)
              if (/[\\/]$/.test(parsed.pathText) && !worktreeRootLink) {
                return null
              }
              // Why: the cwd-relative path is the default target, but a bare
              // filename may instead resolve to a file nested elsewhere in the
              // worktree (see the workspace fallback below).
              let linkAbsolutePath = resolved.absolutePath
              // Why: exact known workspace roots must stay clickable for SSH or
              // stale local paths even when filesystem probing says "missing".
              if (!worktreeRootLink) {
                const cachedExists = readTerminalPathExistsCache(pathExistsCache, cacheKey)
                const exists =
                  cachedExists ??
                  (fileContext.connectionId || isRemoteRuntimePath
                    ? await runtimePathExists(fileContext, resolved.absolutePath)
                    : await window.api.shell.pathExists(resolved.absolutePath))
                writeTerminalPathExistsCache(pathExistsCache, cacheKey, exists)
                if (!exists) {
                  // Why (issue #5024): a bare filename that doesn't exist at the
                  // cwd often refers to a file nested elsewhere in the worktree.
                  // Resolve it with a targeted worktree basename lookup
                  // (local/SSH; runtime hosts are skipped). Only a unique
                  // match links.
                  const workspaceMatch =
                    !isRemoteRuntimePath && !/[\\/]/.test(parsed.pathText)
                      ? await resolveWorkspaceFileByBasename({
                          basename: parsed.pathText,
                          worktreePath,
                          connectionId: fileContext.connectionId
                        })
                      : null
                  if (!workspaceMatch) {
                    return null
                  }
                  linkAbsolutePath = workspaceMatch
                }
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
                    openDetectedFilePath(linkAbsolutePath, resolved.line, resolved.column, {
                      worktreeId,
                      worktreePath,
                      runtimeEnvironmentId,
                      openWithSystemDefault: Boolean(event.shiftKey)
                    })
                  },
                  hover: () => {
                    // Why: only local paths can offer the Shift+modifier system
                    // default escape hatch; remote paths may not exist locally.
                    const canOpenWithSystemDefault = shouldOpenTerminalFileWithSystemDefault(
                      fileContext,
                      linkAbsolutePath
                    )
                    const hint = worktreeRootLink
                      ? getTerminalWorktreePathOpenHint(canOpenWithSystemDefault)
                      : canOpenWithSystemDefault
                        ? isHtmlFilePath(linkAbsolutePath)
                          ? getTerminalHtmlFileOpenHint()
                          : openLinkHint
                        : getTerminalOrcaFileOpenHint()
                    linkTooltip.textContent = `${linkAbsolutePath} (${hint})`
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
        const links = preferLongestNonOverlappingLinks(providedLinks)
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
        startupCwd: deps.getPaneLinkCwd?.(paneId) ?? deps.startupCwd,
        terminalHomePath: deps.terminalHomePath,
        worktreeId: deps.worktreeId,
        worktreePath: deps.worktreePath,
        runtimeEnvironmentId,
        pathExistsCache: deps.pathExistsCache,
        openWithSystemDefault: Boolean(event.shiftKey)
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
