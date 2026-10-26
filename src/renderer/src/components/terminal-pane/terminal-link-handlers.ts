import { dedupeLogicalLines } from './terminal-link-logical-line-deduplication'
import type { TerminalPathExistsCache } from './terminal-path-exists-cache'
import { createTerminalPathExistenceBatch } from './terminal-path-existence-batch'
import type { IDisposable, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { extractTerminalFileLinkCandidates, extractTerminalFileLinks } from '@/lib/terminal-links'
import { preferLongestNonOverlappingMatches } from '@/lib/longest-non-overlapping-matches'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import {
  buildCandidateLogicalLinesForBufferPosition,
  openFilePathLinkAtBufferPosition
} from './terminal-file-link-hit-testing'
import { shouldOpenTerminalFileWithSystemDefault } from './terminal-file-open-routing'
import { isHtmlFilePath, localHtmlFileDestinations } from './local-html-file-destinations'
import { fileLinkTargetExists, resolveFileLinkTarget } from './terminal-file-link-target'
import {
  buildHardWrappedPathLogicalLineCandidates,
  buildWrappedLogicalLine,
  rangeForParsedFileLink,
  type WrappedLogicalLine
} from './wrapped-terminal-link-ranges'
import {
  getTerminalHtmlFileOpenHint,
  getTerminalOrcaFileOpenHint,
  getTerminalWorktreePathOpenHint,
  getTerminalFileOpenHint,
  getTerminalUrlOpenHint
} from './terminal-link-open-hints'
import { isTerminalLinkDirectActivation } from './terminal-link-activation'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'
import type { TerminalLinkActionContext } from './terminal-link-action-request'
import { handleTerminalFileLink } from './terminal-file-link-actions'
import { showFileLinkOpenFailureToast } from '@/lib/file-link-open-failure-toast'

export { openDetectedFilePath } from './terminal-file-open-routing'
export { mapTerminalFilePath } from './terminal-file-open-routing'
export { openFilePathLinkAtBufferPosition } from './terminal-file-link-hit-testing'
export { getTerminalFileOpenHint, getTerminalHtmlFileOpenHint, getTerminalUrlOpenHint }
export { isTerminalLinkActivation } from './terminal-link-activation'

export type LinkHandlerDeps = {
  worktreeId: string
  worktreePath: string
  startupCwd: string
  getPaneLinkCwd?: (paneId: number) => string | null
  managerRef: React.RefObject<PaneManager | null>
  linkProviderDisposablesRef: React.RefObject<Map<number, IDisposable>>
  pathExistsCache: TerminalPathExistsCache
  runtimeEnvironmentId?: string | null
  terminalHomePath?: string | null
  wslDistro?: string | null
  getRuntimeEnvironmentIdForPane?: (paneId: number) => string | null
  /** The pane's terminal on its paired server, which may grant files it printed. */
  getRuntimeTerminalHandleForPane?: (paneId: number) => string | null
  getLinkActionContext?: (paneId: number) => TerminalLinkActionContext | null
  /** The terminal tab whose panes print these links; editor opens place beside its group. */
  sourceTabId?: string
}

type ProvidedFileLink = {
  link: ILink
  logicalLine: WrappedLogicalLine
}

function rangesOverlap(left: ILink['range'], right: ILink['range']): boolean {
  const leftStartsAfterRightEnds =
    left.start.y > right.end.y || (left.start.y === right.end.y && left.start.x > right.end.x)
  const rightStartsAfterLeftEnds =
    right.start.y > left.end.y || (right.start.y === left.end.y && right.start.x > left.end.x)
  return !leftStartsAfterRightEnds && !rightStartsAfterLeftEnds
}

function preferLongestNonOverlappingLinks(links: ProvidedFileLink[]): ProvidedFileLink[] {
  return preferLongestNonOverlappingMatches(links, {
    length: ({ link }) => link.text.length,
    overlaps: (left, right) => rangesOverlap(left.link.range, right.link.range),
    compareStart: (a, b) =>
      a.link.range.start.y - b.link.range.start.y || a.link.range.start.x - b.link.range.start.x
  })
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

      const pathExists = createTerminalPathExistenceBatch()
      // A rejected wrapped-path guess must not hide verified sibling paths.
      void Promise.allSettled(
        logicalLines.flatMap((logicalLine) =>
          extractTerminalFileLinkCandidates(logicalLine.text).map(
            async (parsed): Promise<ProvidedFileLink | null> => {
              const runtimeEnvironmentId =
                deps.getRuntimeEnvironmentIdForPane?.(paneId) ?? deps.runtimeEnvironmentId ?? null
              const target = resolveFileLinkTarget(parsed, {
                cwd: deps.getPaneLinkCwd?.(paneId) ?? startupCwd,
                homePath: deps.terminalHomePath,
                worktreeId,
                worktreePath,
                runtimeEnvironmentId,
                wslDistro: deps.wslDistro
              })
              const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
              if (!target || !range) {
                return null
              }
              const terminalHandle = deps.getRuntimeTerminalHandleForPane?.(paneId) ?? null
              if (
                !(await fileLinkTargetExists(target, pathExistsCache, pathExists, terminalHandle))
              ) {
                return null
              }
              const { absolutePath: mappedPath, fileContext } = target

              return {
                logicalLine,
                link: {
                  range,
                  text: parsed.displayText,
                  activate: (event) => {
                    if (
                      handleTerminalFileLink(
                        mappedPath,
                        target.line,
                        target.column,
                        event,
                        {
                          worktreeId,
                          worktreePath,
                          runtimeEnvironmentId,
                          wslDistro: deps.wslDistro,
                          terminalHandle,
                          sourceTabId: deps.sourceTabId,
                          onOpenFailure: (failure) =>
                            showFileLinkOpenFailureToast(mappedPath, failure)
                        },
                        deps.getLinkActionContext?.(paneId)
                      )
                    ) {
                      pane.terminal.clearSelection?.()
                    }
                  },
                  hover: () => {
                    // Only local paths can use the Shift+modifier OS escape hatch.
                    const canOpenWithSystemDefault =
                      shouldOpenTerminalFileWithSystemDefault(fileContext)
                    const showActions = deps.getLinkActionContext
                      ? deps.getLinkActionContext(paneId) !== null
                      : true
                    const hint = target.isKnownWorktreeRoot
                      ? getTerminalWorktreePathOpenHint(canOpenWithSystemDefault, showActions)
                      : canOpenWithSystemDefault
                        ? isHtmlFilePath(mappedPath)
                          ? getTerminalHtmlFileOpenHint(localHtmlFileDestinations(), showActions)
                          : showActions
                            ? openLinkHint
                            : getTerminalFileOpenHint(false)
                        : getTerminalOrcaFileOpenHint(showActions)
                    linkTooltip.textContent = `${mappedPath} (${hint})`
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
      )
        .then((settledLinks) => {
          const latestFingerprints = new Set(
            buildCandidateLogicalLinesForBufferPosition(buffer, bufferLineNumber).map(
              (logicalLine) => logicalLine.fingerprint
            )
          )
          const providedLinks = settledLinks.flatMap((result) =>
            result.status === 'fulfilled' && result.value !== null ? [result.value] : []
          )
          const links = preferLongestNonOverlappingLinks(providedLinks)
            .filter(({ logicalLine }) => latestFingerprints.has(logicalLine.fingerprint))
            .map(({ link }) => link)
          if (providedLinks.length > 0 && links.length === 0) {
            return
          }
          callback(links.length > 0 ? links : undefined)
        })
        .catch(() => {
          // Stale xterm callbacks must not escape best-effort discovery as unhandled rejections.
        })
    }
  }
}

export function installFilePathLinkClickFallback(
  paneId: number,
  terminal: Terminal,
  deps: LinkHandlerDeps
): IDisposable {
  const mouseUpListenerOptions = { capture: true }
  const handleMouseUp = (event: MouseEvent): void => {
    if (!isTerminalLinkDirectActivation(event)) {
      return
    }

    const position = getTerminalBufferPositionForMouseEvent(terminal, event)
    if (!position) {
      return
    }
    const runtimeEnvironmentId =
      deps.getRuntimeEnvironmentIdForPane?.(paneId) ?? deps.runtimeEnvironmentId ?? null
    // Retry hit testing on modifier mouseup: wrapped links can hover active without clickable-row activation. Opening coalesces duplicates.
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
        wslDistro: deps.wslDistro,
        terminalHandle: deps.getRuntimeTerminalHandleForPane?.(paneId) ?? null,
        pathExistsCache: deps.pathExistsCache,
        openWithSystemDefault: Boolean(event.shiftKey),
        sourceTabId: deps.sourceTabId,
        onOpenFailure: showFileLinkOpenFailureToast
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
