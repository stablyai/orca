import type { Terminal } from '@xterm/xterm'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { findFilePathLinkAtBufferPosition } from './terminal-file-link-hit-testing'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'
import { findHttpLinkAtBufferPosition } from './terminal-url-link-hit-testing'

export type TerminalContextMenuHttpLinkTarget = {
  kind: 'http'
  url: string
  sourceOwner: HttpLinkSourceOwner
}

export type TerminalContextMenuFileLinkTarget = {
  kind: 'file'
  absolutePath: string
  line: number | null
  column: number | null
  pathText: string
}

export type TerminalContextMenuLinkTarget =
  | TerminalContextMenuHttpLinkTarget
  | TerminalContextMenuFileLinkTarget

export type ResolveTerminalContextMenuLinkTargetDeps = {
  startupCwd: string
  worktreeId: string
  worktreePath: string
  terminalHomePath?: string | null
  runtimeEnvironmentId?: string | null
  sourceOwner?: HttpLinkSourceOwner
  pathExistsCache?: Map<string, boolean>
}

/**
 * Resolve the HTTP URL or file path under a context-menu mouse event (#9279).
 * HTTP wins over file when both match (e.g. path-looking query strings in URLs).
 */
export function resolveTerminalContextMenuLinkTarget(
  terminal: Terminal,
  event: Pick<MouseEvent, 'clientX' | 'clientY'>,
  deps: ResolveTerminalContextMenuLinkTargetDeps
): TerminalContextMenuLinkTarget | null {
  const position = getTerminalBufferPositionForMouseEvent(terminal, event as MouseEvent)
  if (!position) {
    return null
  }
  const buffer = terminal.buffer.active
  const httpUrl = findHttpLinkAtBufferPosition(buffer, position, terminal.cols)
  if (httpUrl) {
    return { kind: 'http', url: httpUrl, sourceOwner: deps.sourceOwner ?? { kind: 'local' } }
  }
  if (!deps.startupCwd) {
    return null
  }
  const file = findFilePathLinkAtBufferPosition(buffer, position, terminal.cols, deps)
  if (!file) {
    return null
  }
  return {
    kind: 'file',
    absolutePath: file.absolutePath,
    line: file.line,
    column: file.column,
    pathText: file.pathText
  }
}

export function getTerminalContextMenuLinkCopyText(target: TerminalContextMenuLinkTarget): string {
  return target.kind === 'http' ? target.url : target.absolutePath
}
