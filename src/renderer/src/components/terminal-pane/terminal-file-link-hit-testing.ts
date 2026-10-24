import { dedupeLogicalLines } from './terminal-link-logical-line-deduplication'
import {
  readTerminalPathExistence,
  type TerminalPathExistsCache
} from './terminal-path-exists-cache'
import type { IBufferLine, IBufferRange } from '@xterm/xterm'
import { extractTerminalFileLinkCandidates } from '@/lib/terminal-links'
import {
  getTerminalFileContext,
  openDetectedFilePath,
  type FileOpenFailure,
  type TerminalFileContext
} from './terminal-file-open-routing'
import { reserveDetectedFilePathOpenTurn } from './terminal-file-open-turn'
import {
  fileLinkTargetExists,
  mayCheckFileLinkTargetUnprompted,
  resolveFileLinkTarget,
  type FileLinkHost,
  type FileLinkTarget
} from './terminal-file-link-target'
import { createTerminalPathExistenceBatch } from './terminal-path-existence-batch'
import { terminalLogicalLinkHasOscLink } from './terminal-osc-link-cells'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import { getRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
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
  pathExistsCache?: TerminalPathExistsCache
  openWithSystemDefault?: boolean
  sourceTabId?: string | null
  /** Tells the user why a click opened nothing; skipped once a later click supersedes it. */
  onOpenFailure?: (absolutePath: string, failure: FileOpenFailure) => void
}

type ClickedFileLink = FileLinkTarget & {
  pathText: string
  cachedExists: boolean | undefined
  hasOscLink: boolean
}

// Why: a slow probe from an earlier click must not open its file after a later click.
let latestClickGesture = 0

export function openFilePathLinkAtBufferPosition(
  buffer: { getLine(y: number): IBufferLine | undefined },
  position: { x: number; y: number },
  terminalColumns: number,
  deps: FileLinkHitTestDeps
): boolean {
  const gesture = ++latestClickGesture
  const links: ClickedFileLink[] = []
  for (const logicalLine of buildCandidateLogicalLinesForBufferPosition(buffer, position.y)) {
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
      links.push({
        ...target,
        pathText: parsed.pathText,
        cachedExists: deps.pathExistsCache
          ? readTerminalPathExistence(deps.pathExistsCache, target.cacheKey)
          : undefined,
        hasOscLink: terminalLogicalLinkHasOscLink(
          buffer,
          logicalLine,
          parsed.startIndex,
          parsed.endIndex
        )
      })
    }
  }

  // Why: a failure names the path the user sees, not a longer joined guess.
  const shown = shortestPath(links)
  const open = (link: ClickedFileLink, verified = link.cachedExists === true): void => {
    const { onOpenFailure } = deps
    // Why: a bare dotted word (`console.log`, `example.com`) is not a claim that a file exists.
    const reportsFailure =
      onOpenFailure && (verified || link.isKnownWorktreeRoot || /[\\/]/.test(link.pathText))
    const reportedPath =
      verified || link.isKnownWorktreeRoot || !shown ? link.absolutePath : shown.absolutePath
    openDetectedFilePath(link.absolutePath, link.line, link.column, {
      ...deps,
      openWithSystemDefault: deps.openWithSystemDefault === true,
      onOpenFailure: reportsFailure ? (failure) => onOpenFailure(reportedPath, failure) : undefined
    })
  }
  const host: FileLinkHost = { ...deps, cwd: deps.startupCwd, homePath: deps.terminalHomePath }
  // Why: a share outside the workspace is never stat'ed unprompted; like a verified path, its
  // guess opens as is and the host resolves it.
  const settled = (link: ClickedFileLink): boolean =>
    link.cachedExists === true ||
    link.isKnownWorktreeRoot ||
    (link.cachedExists === undefined && !mayCheckFileLinkTargetUnprompted(link, host))
  const unique = links.filter(
    (link, index) => links.findIndex((other) => other.cacheKey === link.cacheKey) === index
  )
  const best = longestPath(unique.filter(settled))
  // Why longer only: a cached `foo.ts` must not win over an unchecked hard-wrapped `foo.ts.map`.
  const toProbe = unique.filter(
    (link) =>
      link.cachedExists === undefined &&
      !settled(link) &&
      (!best || link.pathText.length > best.pathText.length)
  )
  if (toProbe.length === 0 || (!best && toProbe.length === 1)) {
    // Why the visible path last: a click on a path already known missing still says so.
    // An OSC 8 hyperlink there is xterm's to open.
    const knownMissing =
      shown && !shown.hasOscLink && /[\\/]/.test(shown.pathText) ? shown : undefined
    const link = best ?? toProbe[0] ?? knownMissing
    if (link) {
      open(link)
    }
    return link !== undefined
  }

  // Why: hard-wrap joining offers guesses like `a.txt/b.txt` that sort first; opening one
  // before its hover probe answers (a host round-trip) fails and hides the real path.
  const isLatestOpen = reserveDetectedFilePathOpenTurn()
  const clickedHost = fileHostFingerprint(toProbe[0].fileContext)
  void probeClickedFileLinks(toProbe, deps).then((existing) => {
    // Why: if the workspace's host or pairing changed meanwhile, a same-named file there is not
    // the one clicked.
    const currentHost = fileHostFingerprint(
      getTerminalFileContext(deps.worktreeId, deps.worktreePath, deps.runtimeEnvironmentId)
    )
    if (gesture !== latestClickGesture || !isLatestOpen() || currentHost !== clickedHost) {
      return
    }
    const found = longestPath(existing)
    // Why the shortest otherwise: opening it lets the open report the real failure instead of
    // a probe guessing "missing" for a refusal.
    const link = found ?? best ?? shortestPath(toProbe)
    if (link) {
      open(link, link === found || link.cachedExists === true)
    }
  })
  return true
}

function fileHostFingerprint(context: TerminalFileContext): string {
  const environmentId = runtimeTargetEnvironmentId(context.target)
  return JSON.stringify([context, environmentId && getRuntimeEnvironmentRevision(environmentId)])
}

async function probeClickedFileLinks(
  links: ClickedFileLink[],
  deps: FileLinkHitTestDeps
): Promise<ClickedFileLink[]> {
  const pathExists = createTerminalPathExistenceBatch()
  const cache: TerminalPathExistsCache = deps.pathExistsCache ?? new Map()
  const exists = await Promise.all(
    links.map((link) =>
      // Why: a guess the host cannot answer must not hide a sibling.
      fileLinkTargetExists(link, cache, pathExists, deps.terminalHandle).catch(() => false)
    )
  )
  return links.filter((_, index) => exists[index])
}

function shortestPath(links: ClickedFileLink[]): ClickedFileLink | undefined {
  return links.reduce<ClickedFileLink | undefined>(
    (best, link) => (!best || link.pathText.length < best.pathText.length ? link : best),
    undefined
  )
}

function longestPath(links: ClickedFileLink[]): ClickedFileLink | undefined {
  return links.reduce<ClickedFileLink | undefined>(
    (best, link) => (!best || link.pathText.length > best.pathText.length ? link : best),
    undefined
  )
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
