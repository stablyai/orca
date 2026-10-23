import type { LinkHandlerDeps } from './terminal-link-handlers'
import { findFilePathLinkAtBufferPosition } from './terminal-file-link-hit-testing'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'

export type TerminalContextMenuFileLinkResolver = (
  paneId: number,
  event: MouseEvent
) => string | null

export function createTerminalContextMenuFileLinkResolver(
  deps: LinkHandlerDeps
): TerminalContextMenuFileLinkResolver {
  return (paneId, event) => {
    const pane = deps.managerRef.current?.getPanes().find((candidate) => candidate.id === paneId)
    if (!pane) {
      return null
    }
    const position = getTerminalBufferPositionForMouseEvent(pane.terminal, event)
    if (!position) {
      return null
    }
    const runtimeEnvironmentId =
      deps.getRuntimeEnvironmentIdForPane?.(paneId) ?? deps.runtimeEnvironmentId ?? null
    return (
      findFilePathLinkAtBufferPosition(pane.terminal.buffer.active, position, pane.terminal.cols, {
        startupCwd: deps.getPaneLinkCwd?.(paneId) ?? deps.startupCwd,
        terminalHomePath: deps.terminalHomePath,
        worktreeId: deps.worktreeId,
        worktreePath: deps.worktreePath,
        runtimeEnvironmentId,
        wslDistro: deps.wslDistro,
        terminalHandle: deps.getRuntimeTerminalHandleForPane?.(paneId) ?? null,
        pathExistsCache: deps.pathExistsCache,
        includeCachedMissing: true
      })?.absolutePath ?? null
    )
  }
}
