import type { IBufferLine, IBufferRange } from '@xterm/xterm'
import { extractTerminalFileLinkCandidates, resolveTerminalFileLink } from '@/lib/terminal-links'
import { isRemoteRuntimeFileOperation } from '@/runtime/runtime-file-client'
import {
  getTerminalFileContext,
  mapTerminalFilePath,
  openDetectedFilePath,
  terminalLinkWslDistro
} from './terminal-file-open-routing'
import { createTerminalPathExistenceBatch } from './terminal-path-existence-batch'
import {
  getTerminalPathExistsCacheKey,
  writeTerminalPathExistsCache
} from './terminal-path-exists-cache'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'
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

  const fileContext = getTerminalFileContext(
    deps.worktreeId,
    deps.worktreePath,
    deps.runtimeEnvironmentId
  )
  const matches: {
    absolutePath: string
    line: number | null
    column: number | null
    pathText: string
    cacheKey: string
    isRemoteRuntimePath: boolean
    cachedExists: boolean | undefined
    isKnownWorktreeRoot: boolean
  }[] = []
  for (const logicalLine of logicalLines) {
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
      const mappedPath = mapTerminalFilePath(
        resolved.absolutePath,
        deps.worktreePath,
        terminalLinkWslDistro(deps.wslDistro, deps.runtimeEnvironmentId)
      )
      const isRemoteRuntimePath = isRemoteRuntimeFileOperation(fileContext, mappedPath)
      const cacheKey = getTerminalPathExistsCacheKey({
        absolutePath: mappedPath,
        connectionId: fileContext.connectionId,
        isRemoteRuntimePath,
        runtimeEnvironmentId: deps.runtimeEnvironmentId
      })
      const isKnownWorktreeRoot = Boolean(resolveKnownWorktreeRootPathLink(mappedPath))
      if (/[\\/]$/.test(parsed.pathText) && !isKnownWorktreeRoot) {
        continue
      }
      matches.push({
        absolutePath: mappedPath,
        line: resolved.line,
        column: resolved.column,
        pathText: parsed.pathText,
        cacheKey,
        isRemoteRuntimePath,
        cachedExists: deps.pathExistsCache?.get(cacheKey),
        isKnownWorktreeRoot
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
  void Promise.all(
    uncached.map(async (candidate) => {
      const exists = await pathExists(
        fileContext,
        candidate.absolutePath,
        candidate.isRemoteRuntimePath
      )
      if (deps.pathExistsCache) {
        writeTerminalPathExistsCache(deps.pathExistsCache, candidate.cacheKey, exists)
      }
      return exists ? candidate : null
    })
  ).then(
    (probed) => {
      const existing = probed
        .filter((candidate): candidate is (typeof matches)[number] => candidate !== null)
        .sort(byLongestPath)[0]
      if (existing) {
        openMatch(existing)
      }
    },
    () => {
      // Why: a lost host connection is not evidence the file is missing; the
      // click simply does nothing rather than opening a guessed path.
    }
  )
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
