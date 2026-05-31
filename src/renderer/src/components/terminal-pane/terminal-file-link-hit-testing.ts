import type { IBufferLine, IBufferRange } from '@xterm/xterm'
import { extractTerminalFileLinkCandidates, resolveTerminalFileLink } from '@/lib/terminal-links'
import { openDetectedFilePath } from './terminal-file-open-routing'
import {
  buildHardWrappedPathLogicalLineCandidates,
  buildWrappedLogicalLine,
  rangeForParsedFileLink,
  type WrappedLogicalLine
} from './wrapped-terminal-link-ranges'

type FileLinkHitTestDeps = {
  startupCwd: string
  terminalHomePath?: string | null
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
  pathExistsCache?: Map<string, boolean>
  openWithSystemDefault?: boolean
}

export function openFilePathLinkAtBufferPosition(
  buffer: { getLine(y: number): IBufferLine | undefined },
  position: { x: number; y: number },
  terminalColumns: number,
  deps: FileLinkHitTestDeps
): boolean {
  const logicalLines = buildCandidateLogicalLinesForBufferPosition(buffer, position.y)
  if (logicalLines.length === 0) {
    return false
  }

  for (const logicalLine of logicalLines) {
    const matches: {
      absolutePath: string
      line: number | null
      column: number | null
      pathText: string
      cachedExists: boolean | undefined
    }[] = []
    for (const parsed of extractTerminalFileLinkCandidates(logicalLine.text)) {
      const resolved = deps.startupCwd
        ? resolveTerminalFileLink(parsed, deps.startupCwd, deps.terminalHomePath)
        : null
      if (!resolved) {
        continue
      }
      const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
      if (!range || !rangeContainsBufferPosition(range, position, terminalColumns)) {
        continue
      }
      const cacheKey = `${deps.runtimeEnvironmentId ?? 'active'}\0${resolved.absolutePath}`
      matches.push({
        absolutePath: resolved.absolutePath,
        line: resolved.line,
        column: resolved.column,
        pathText: parsed.pathText,
        cachedExists: deps.pathExistsCache?.get(cacheKey)
      })
    }

    const cachedMatch = matches
      .filter((match) => match.cachedExists)
      .sort((a, b) => b.pathText.length - a.pathText.length)[0]
    const uncachedMatch = matches.find((match) => match.cachedExists !== false)
    const match = cachedMatch ?? uncachedMatch
    if (match) {
      openDetectedFilePath(match.absolutePath, match.line, match.column, {
        ...deps,
        openWithSystemDefault: deps.openWithSystemDefault === true
      })
      return true
    }
  }

  return false
}

export function buildCandidateLogicalLinesForBufferPosition(
  buffer: { getLine(y: number): IBufferLine | undefined },
  bufferLineNumber: number
): WrappedLogicalLine[] {
  const hardWrappedCandidates = buildHardWrappedPathLogicalLineCandidates(buffer, bufferLineNumber)
  const softWrappedLogicalLine = buildWrappedLogicalLine(buffer, bufferLineNumber)
  const candidates = softWrappedLogicalLine
    ? [...hardWrappedCandidates, softWrappedLogicalLine]
    : hardWrappedCandidates
  return dedupeLogicalLines(candidates)
}

export function dedupeLogicalLines(logicalLines: WrappedLogicalLine[]): WrappedLogicalLine[] {
  const seen = new Set<string>()
  return logicalLines.filter((logicalLine) => {
    if (seen.has(logicalLine.fingerprint)) {
      return false
    }
    seen.add(logicalLine.fingerprint)
    return true
  })
}

function rangeContainsBufferPosition(
  range: IBufferRange,
  position: { x: number; y: number },
  terminalColumns: number
): boolean {
  const lower = range.start.y * terminalColumns + range.start.x
  const upper = range.end.y * terminalColumns + range.end.x
  const current = position.y * terminalColumns + position.x
  return lower <= current && current <= upper
}
