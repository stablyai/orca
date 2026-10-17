export const GIT_BLAME_ZERO_OID_RE = /^0+$/

export type GitBlameLine = {
  line: number
  commitOid: string
  author: string
  authorTime: number
  summary: string
}

export type GitBlameResult = {
  status: 'ready' | 'unavailable'
  lines: GitBlameLine[]
}

const HEADER_LINE_RE = /^([0-9a-fA-F]+)\s+\d+\s+(\d+)(?:\s+\d+)?$/

export const GIT_BLAME_HEAD_REVISION = 'HEAD'
export const GIT_BLAME_INDEX_CONTENTS = 'index' as const

export type GitBlameContentsSource = typeof GIT_BLAME_INDEX_CONTENTS

const FULL_GIT_OBJECT_ID_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/

export function parseGitBlameRevision(revision: unknown): string | undefined {
  if (revision == null || revision === '') {
    return undefined
  }
  if (revision === GIT_BLAME_HEAD_REVISION) {
    return GIT_BLAME_HEAD_REVISION
  }
  if (typeof revision !== 'string' || !FULL_GIT_OBJECT_ID_RE.test(revision)) {
    throw new Error('revision must be a full git object id')
  }
  return revision
}

export function isUncommittedBlameOid(oid: string): boolean {
  return oid.length > 0 && GIT_BLAME_ZERO_OID_RE.test(oid)
}

export function buildGitShowIndexArgv(filePath: string): string[] {
  return ['show', '--end-of-options', `:${filePath.replace(/\\/g, '/')}`]
}

export function buildGitBlameArgv(
  filePath: string,
  revision?: string,
  contentsSource?: GitBlameContentsSource
): string[] {
  const blameRevision =
    revision ?? (contentsSource === GIT_BLAME_INDEX_CONTENTS ? GIT_BLAME_HEAD_REVISION : undefined)
  return [
    'blame',
    '--encoding=UTF-8',
    '--line-porcelain',
    '-w',
    ...(contentsSource === GIT_BLAME_INDEX_CONTENTS ? ['--contents', '-'] : []),
    ...(blameRevision ? [blameRevision] : []),
    '--end-of-options',
    '--',
    filePath
  ]
}

export function parseBlamePorcelain(stdout: string): GitBlameLine[] {
  const lines: GitBlameLine[] = []
  let pendingOid = ''
  let pendingLine = 0
  let author = ''
  let authorTime = 0
  let summary = ''

  for (const raw of stdout.split('\n')) {
    if (raw.startsWith('\t')) {
      if (pendingLine > 0 && pendingOid) {
        lines.push({
          line: pendingLine,
          commitOid: pendingOid,
          author,
          authorTime,
          summary
        })
      }
      pendingOid = ''
      pendingLine = 0
      continue
    }

    const header = HEADER_LINE_RE.exec(raw)
    if (header) {
      pendingOid = header[1] ?? ''
      pendingLine = Number(header[2])
      continue
    }

    if (raw.startsWith('author ')) {
      author = raw.slice('author '.length)
      continue
    }
    if (raw.startsWith('author-time ')) {
      const parsed = Number(raw.slice('author-time '.length))
      authorTime = Number.isFinite(parsed) ? parsed : 0
      continue
    }
    if (raw.startsWith('summary ')) {
      summary = raw.slice('summary '.length)
    }
  }

  return lines
}

export type GitBlameLineIndex = ReadonlyMap<number, GitBlameLine>

export function indexBlameLinesByNumber(lines: readonly GitBlameLine[]): GitBlameLineIndex {
  return new Map(lines.map((line) => [line.line, line]))
}

export function formatBlameRelativeTime(epochSeconds: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) {
    return ''
  }
  const deltaSeconds = Math.round(nowMs / 1000 - epochSeconds)
  const abs = Math.abs(deltaSeconds)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 60) {
    return formatter.format(-deltaSeconds, 'second')
  }
  if (abs < 3600) {
    return formatter.format(-Math.round(deltaSeconds / 60), 'minute')
  }
  if (abs < 86400) {
    return formatter.format(-Math.round(deltaSeconds / 3600), 'hour')
  }
  if (abs < 2_592_000) {
    return formatter.format(-Math.round(deltaSeconds / 86400), 'day')
  }
  if (abs < 31_536_000) {
    return formatter.format(-Math.round(deltaSeconds / 2_592_000), 'month')
  }
  return formatter.format(-Math.round(deltaSeconds / 31_536_000), 'year')
}

export function formatBlameAnnotation(
  line: GitBlameLine,
  options: { uncommittedLabel: string; nowMs?: number } = { uncommittedLabel: 'Not Committed Yet' }
): string {
  if (isUncommittedBlameOid(line.commitOid)) {
    return options.uncommittedLabel
  }
  const relative = formatBlameRelativeTime(line.authorTime, options.nowMs)
  const summary = line.summary.trim()
  const parts = [line.author.trim() || 'Unknown', relative].filter((part) => part.length > 0)
  const prefix = parts.join(', ')
  if (!summary) {
    return prefix
  }
  const clipped = summary.length > 50 ? `${summary.slice(0, 49)}…` : summary
  return `${prefix} • ${clipped}`
}
