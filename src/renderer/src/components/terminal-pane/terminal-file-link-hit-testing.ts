import type { IBufferLine, IBufferRange } from '@xterm/xterm'
import { extractTerminalFileLinkCandidates } from '@/lib/terminal-links'
import { openDetectedFilePath } from './terminal-file-open-routing'
import {
  fileLinkTargetExists,
  resolveFileLinkTarget,
  type FileLinkTarget
} from './terminal-file-link-target'
import { createTerminalPathExistenceBatch } from './terminal-path-existence-batch'
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
  wslDistro?: string | null
  terminalHandle?: string | null
  pathExistsCache?: Map<string, boolean>
  openWithSystemDefault?: boolean
}

// Why: a slow probe from an earlier click must not open its file after the
// user has already clicked somewhere else.
let latestProbedClickGesture = 0

export function openFilePathLinkAtBufferPosition(
  buffer: { getLine(y: number): IBufferLine | undefined },
  position: { x: number; y: number },
  terminalColumns: number,
  deps: FileLinkHitTestDeps
): boolean {
  const gesture = ++latestProbedClickGesture
  const logicalLines = buildCandidateLogicalLinesForBufferPosition(buffer, position.y)
  if (logicalLines.length === 0) {
    return false
  }

  const matches: (FileLinkTarget & {
    pathText: string
    cachedExists: boolean | undefined
  })[] = []
  for (const logicalLine of logicalLines) {
    for (const parsed of extractTerminalFileLinkCandidates(logicalLine.text)) {
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
      const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
      if (!range || !rangeContainsBufferPosition(range, position, terminalColumns)) {
        continue
      }
      matches.push({
        ...target,
        pathText: parsed.pathText,
        cachedExists: deps.pathExistsCache?.get(target.cacheKey)
      })
    }
  }

  const openMatch = (match: (typeof matches)[number]): void => {
    openDetectedFilePath(match.absolutePath, match.line, match.column, {
      ...deps,
      openWithSystemDefault: deps.openWithSystemDefault === true
    })
  }
  const byLongestPath = (a: (typeof matches)[number], b: (typeof matches)[number]): number =>
    b.pathText.length - a.pathText.length
  const cachedMatch = matches.filter((match) => match.cachedExists).sort(byLongestPath)[0]
  const knownWorktreeRootMatch = matches
    .filter((match) => match.isKnownWorktreeRoot)
    .sort(byLongestPath)[0]
  const match = cachedMatch ?? knownWorktreeRootMatch
  if (match) {
    openMatch(match)
    return true
  }

  const uncached = matches.filter(
    (candidate, index) =>
      candidate.cachedExists === undefined &&
      matches.findIndex((other) => other.absolutePath === candidate.absolutePath) === index
  )
  if (uncached.length === 0) {
    return false
  }
  if (uncached.length === 1) {
    openMatch(uncached[0])
    return true
  }

  // Why: hard-wrap joining can offer a real single-row path alongside a bogus
  // path glued to the next row; opening the first unprobed guess fails silently
  // when the hover probe has not answered yet, so probe them all first.
  const pathExists = createTerminalPathExistenceBatch()
  const pathExistsCache = deps.pathExistsCache ?? new Map<string, boolean>()
  // Why: allSettled so one candidate's probe error (permission, transport) does
  // not discard a sibling that resolved; a lost host connection rejects every
  // probe and the click opens nothing rather than a guessed path.
  void Promise.allSettled(
    uncached.map(async (candidate) => {
      const exists = await fileLinkTargetExists(
        candidate,
        pathExistsCache,
        pathExists,
        deps.terminalHandle
      )
      return exists ? candidate : null
    })
  ).then((settled) => {
    if (gesture !== latestProbedClickGesture) {
      return
    }
    const existing = settled
      .flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []))
      .sort(byLongestPath)[0]
    if (existing) {
      openMatch(existing)
    }
  })
  return true
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
