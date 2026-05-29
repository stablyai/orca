import type { IDisposable, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
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
  shouldOpenTerminalFileWithSystemDefault,
  shouldProbeTerminalFilePathThroughRuntime
} from './terminal-file-open-routing'
import {
  buildHardWrappedPathLogicalLineCandidates,
  buildWrappedLogicalLine,
  rangeForParsedFileLink,
  type WrappedLogicalLine
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
import { getBufferPositionForTerminalMouseEvent } from './terminal-mouse-buffer-position'

export { openDetectedFilePath } from './terminal-file-open-routing'
export { openFilePathLinkAtBufferPosition } from './terminal-file-link-hit-testing'
export { getBufferPositionForTerminalMouseEvent } from './terminal-mouse-buffer-position'
export { getTerminalFileOpenHint, getTerminalHtmlFileOpenHint, getTerminalUrlOpenHint }

export type LinkHandlerDeps = {
  worktreeId: string
  worktreePath: string
  startupCwd: string
  managerRef: React.RefObject<PaneManager | null>
  linkProviderDisposablesRef: React.RefObject<Map<number, IDisposable>>
  pathExistsCache: Map<string, boolean>
  runtimeEnvironmentId?: string | null
  terminalHomePath?: string | null
  getRuntimeEnvironmentIdForPane?: (paneId: number) => string | null
}

type ProvidedFileLink = {
  link: ILink
  logicalLine: WrappedLogicalLine
}

function resolveRuntimeEnvironmentIdForPane(
  deps: Pick<LinkHandlerDeps, 'getRuntimeEnvironmentIdForPane' | 'runtimeEnvironmentId'>,
  paneId: number
): string | null | undefined {
  // Why: null is an explicit local-owner signal; undefined means fall back to
  // the currently active runtime settings.
  if (deps.getRuntimeEnvironmentIdForPane) {
    return deps.getRuntimeEnvironmentIdForPane(paneId)
  }
  return deps.runtimeEnvironmentId
}

function rangesOverlap(left: ILink['range'], right: ILink['range']): boolean {
  const leftStartsAfterRightEnds =
    left.start.y > right.end.y || (left.start.y === right.end.y && left.start.x > right.end.x)
  const rightStartsAfterLeftEnds =
    right.start.y > left.end.y || (right.start.y === left.end.y && right.start.x > left.end.x)
  return !leftStartsAfterRightEnds && !rightStartsAfterLeftEnds
}

function preferLongestNonOverlappingLinks(links: ProvidedFileLink[]): ProvidedFileLink[] {
  const selected: ProvidedFileLink[] = []
  const byLengthDescending = [...links].sort(
    (a, b) =>
      b.link.text.length - a.link.text.length ||
      a.link.range.start.y - b.link.range.start.y ||
      a.link.range.start.x - b.link.range.start.x
  )
  for (const link of byLengthDescending) {
    if (!selected.some((existing) => rangesOverlap(existing.link.range, link.link.range))) {
      selected.push(link)
    }
  }
  return selected.sort(
    (a, b) =>
      a.link.range.start.y - b.link.range.start.y || a.link.range.start.x - b.link.range.start.x
  )
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
              const resolved = startupCwd
                ? resolveTerminalFileLink(parsed, startupCwd, deps.terminalHomePath)
                : null
              if (!resolved) {
                return null
              }
              const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
              if (!range) {
                return null
              }

              const runtimeEnvironmentId = resolveRuntimeEnvironmentIdForPane(deps, paneId)
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
              // Why: exact known workspace roots must stay clickable for SSH or
              // stale local paths even when filesystem probing says "missing".
              if (!worktreeRootLink) {
                const cachedExists = readTerminalPathExistsCache(pathExistsCache, cacheKey)
                const exists =
                  cachedExists ??
                  // Why: runtime-owned paths must probe the remote host, never the
                  // local FS; a failed remote probe means "not present" here.
                  (shouldProbeTerminalFilePathThroughRuntime(fileContext)
                    ? await runtimePathExists(fileContext, resolved.absolutePath).catch(() => false)
                    : await window.api.shell.pathExists(resolved.absolutePath))
                writeTerminalPathExistsCache(pathExistsCache, cacheKey, exists)
                if (!exists) {
                  return null
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
                    openDetectedFilePath(resolved.absolutePath, resolved.line, resolved.column, {
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
                      resolved.absolutePath
                    )
                    const hint = worktreeRootLink
                      ? getTerminalWorktreePathOpenHint(canOpenWithSystemDefault)
                      : canOpenWithSystemDefault
                        ? isHtmlFilePath(resolved.absolutePath)
                          ? getTerminalHtmlFileOpenHint()
                          : openLinkHint
                        : getTerminalOrcaFileOpenHint()
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
    const runtimeEnvironmentId = resolveRuntimeEnvironmentIdForPane(deps, paneId)
    // Why: xterm can show a wrapped provider link as active while still missing
    // activation for the clicked wrapped row. Always retry file-path hit testing
    // on modifier mouseup; openDetectedFilePath coalesces duplicate opens.
    const opened = openFilePathLinkAtBufferPosition(
      terminal.buffer.active,
      position,
      terminal.cols,
      {
        startupCwd: deps.startupCwd,
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
