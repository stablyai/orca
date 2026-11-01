import type { Terminal } from '@xterm/xterm'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'
import {
  findTerminalFileLinksAtBufferPosition,
  findTerminalHttpLinkAtBufferPosition
} from '../../../../shared/terminal-link-buffer-hit-testing'
import { getTerminalBufferPositionForMouseEvent } from './terminal-mouse-buffer-position'
import {
  readTerminalPathExistence,
  type TerminalPathExistsCache
} from './terminal-path-exists-cache'
import { resolveFileLinkTarget } from './terminal-file-link-target'

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
  wslDistro?: string | null
  pathExistsCache?: TerminalPathExistsCache
}

type ResolvedFileMatch = {
  absolutePath: string
  line: number | null
  column: number | null
  pathText: string
  cachedExists: boolean | undefined
  isKnownWorktreeRoot: boolean
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
  const httpUrl = findTerminalHttpLinkAtBufferPosition(buffer, position, terminal.cols)
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

function findFilePathLinkAtBufferPosition(
  buffer: Parameters<typeof findTerminalFileLinksAtBufferPosition>[0],
  position: { x: number; y: number },
  terminalColumns: number,
  deps: ResolveTerminalContextMenuLinkTargetDeps
): ResolvedFileMatch | null {
  const readings = findTerminalFileLinksAtBufferPosition(buffer, position, terminalColumns)
  const matches: ResolvedFileMatch[] = []
  for (const parsed of readings.links) {
    const target = resolveFileLinkTarget(parsed, {
      cwd: deps.startupCwd,
      homePath: deps.terminalHomePath,
      worktreeId: deps.worktreeId,
      worktreePath: deps.worktreePath,
      runtimeEnvironmentId: deps.runtimeEnvironmentId,
      wslDistro: deps.wslDistro
    })
    if (!target) {
      continue
    }
    matches.push({
      absolutePath: target.absolutePath,
      line: target.line,
      column: target.column,
      pathText: parsed.pathText,
      cachedExists: deps.pathExistsCache
        ? readTerminalPathExistence(deps.pathExistsCache, target.cacheKey)
        : undefined,
      isKnownWorktreeRoot: target.isKnownWorktreeRoot
    })
  }
  const longest = (items: ResolvedFileMatch[]): ResolvedFileMatch | undefined =>
    [...items].sort((a, b) => b.pathText.length - a.pathText.length)[0]
  const match =
    longest(matches.filter((item) => item.cachedExists)) ??
    longest(matches.filter((item) => item.isKnownWorktreeRoot)) ??
    matches.find((item) => item.cachedExists !== false)
  return match ?? null
}

export function getTerminalContextMenuLinkCopyText(target: TerminalContextMenuLinkTarget): string {
  return target.kind === 'http' ? target.url : target.absolutePath
}
