export type ParsedTerminalFileLink = {
  pathText: string
  line: number | null
  column: number | null
  startIndex: number
  endIndex: number
  displayText: string
}

export type ResolvedTerminalFileLink = {
  absolutePath: string
  line: number | null
  column: number | null
}

const FILE_LINK_CANDIDATE_REGEX =
  /(?:\/|\.{1,2}\/|[A-Za-z0-9._-]+\/)[A-Za-z0-9._~\-/]*(?::\d+)?(?::\d+)?/g

const LEADING_TRIM_CHARS = new Set(['(', '[', '{', '"', "'"])
const TRAILING_TRIM_CHARS = new Set([')', ']', '}', '"', "'", ',', ';', '.'])

function trimBoundaryPunctuation(
  value: string,
  startIndex: number
): { text: string; startIndex: number; endIndex: number } | null {
  let start = 0
  let end = value.length

  while (start < end && LEADING_TRIM_CHARS.has(value[start])) {
    start += 1
  }
  while (end > start && TRAILING_TRIM_CHARS.has(value[end - 1])) {
    end -= 1
  }

  if (start >= end) {
    return null
  }

  return {
    text: value.slice(start, end),
    startIndex: startIndex + start,
    endIndex: startIndex + end
  }
}

function parsePathWithOptionalLineColumn(value: string): {
  pathText: string
  line: number | null
  column: number | null
} | null {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value)
  if (!match) {
    return null
  }
  const pathText = match[1]
  if (!pathText || pathText.endsWith('/')) {
    return null
  }

  const line = match[2] ? Number.parseInt(match[2], 10) : null
  const column = match[3] ? Number.parseInt(match[3], 10) : null
  if ((line !== null && line < 1) || (column !== null && column < 1)) {
    return null
  }

  return { pathText, line, column }
}

type NormalizedAbsolutePath = {
  normalized: string
  comparisonKey: string
  rootKind: 'posix' | 'windows' | 'unc'
}

function normalizeSegments(pathValue: string): string[] {
  const segments = pathValue.split(/[\\/]+/)
  const stack: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (stack.length > 0) {
        stack.pop()
      }
      continue
    }
    stack.push(segment)
  }

  return stack
}

function normalizeAbsolutePath(pathValue: string): NormalizedAbsolutePath | null {
  const windowsDriveMatch = /^([A-Za-z]):[\\/]*(.*)$/.exec(pathValue)
  if (windowsDriveMatch) {
    const driveLetter = windowsDriveMatch[1].toUpperCase()
    const suffix = normalizeSegments(windowsDriveMatch[2]).join('/')
    const normalized = suffix ? `${driveLetter}:/${suffix}` : `${driveLetter}:/`
    return {
      normalized,
      comparisonKey: normalized.toLowerCase(),
      rootKind: 'windows'
    }
  }

  const uncMatch = /^\\\\([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]*(.*))?$/.exec(pathValue)
  if (uncMatch) {
    const server = uncMatch[1]
    const share = uncMatch[2]
    const suffix = normalizeSegments(uncMatch[3] ?? '').join('/')
    const normalizedRoot = `//${server}/${share}`
    const normalized = suffix ? `${normalizedRoot}/${suffix}` : normalizedRoot
    return {
      normalized,
      comparisonKey: normalized.toLowerCase(),
      rootKind: 'unc'
    }
  }

  if (pathValue.startsWith('/')) {
    const normalized = `/${normalizeSegments(pathValue).join('/')}`.replace(/\/+$/, '') || '/'
    return {
      normalized,
      comparisonKey: normalized,
      rootKind: 'posix'
    }
  }

  return null
}

function joinAbsolutePath(basePath: string, relativePath: string): string | null {
  const normalizedBase = normalizeAbsolutePath(basePath)
  if (!normalizedBase) {
    return null
  }

  return normalizeJoinedPath(normalizedBase, relativePath)
}

function normalizeJoinedPath(basePath: NormalizedAbsolutePath, relativePath: string): string {
  const normalizedBaseSegments = normalizeSegments(basePath.normalized)
  const relativeSegments = normalizeSegments(relativePath)
  const joinedSegments = [...normalizedBaseSegments, ...relativeSegments]

  if (basePath.rootKind === 'unc') {
    const [server, share, ...rest] = joinedSegments
    return rest.length > 0 ? `//${server}/${share}/${rest.join('/')}` : `//${server}/${share}`
  }

  if (basePath.rootKind === 'windows') {
    const [drive, ...rest] = joinedSegments
    return rest.length > 0 ? `${drive}/${rest.join('/')}` : drive
  }

  return `/${joinedSegments.join('/')}`.replace(/\/+$/, '') || '/'
}

export function extractTerminalFileLinks(lineText: string): ParsedTerminalFileLink[] {
  const results: ParsedTerminalFileLink[] = []
  const matches = lineText.matchAll(FILE_LINK_CANDIDATE_REGEX)
  for (const match of matches) {
    const rawText = match[0]
    const rawStart = match.index ?? 0

    const trimmed = trimBoundaryPunctuation(rawText, rawStart)
    if (!trimmed) {
      continue
    }

    const candidateText = trimmed.text
    if (candidateText.includes('://')) {
      continue
    }
    const prefix = lineText.slice(0, trimmed.startIndex)
    if (/[A-Za-z][A-Za-z0-9+.-]*:\/\/$/.test(prefix)) {
      continue
    }
    if (!candidateText.includes('/')) {
      continue
    }

    const parsed = parsePathWithOptionalLineColumn(candidateText)
    if (!parsed) {
      continue
    }

    results.push({
      pathText: parsed.pathText,
      line: parsed.line,
      column: parsed.column,
      startIndex: trimmed.startIndex,
      endIndex: trimmed.endIndex,
      displayText: candidateText
    })
  }

  return results
}

export function resolveTerminalFileLink(
  parsed: ParsedTerminalFileLink,
  cwd: string
): ResolvedTerminalFileLink | null {
  const absolutePath =
    normalizeAbsolutePath(parsed.pathText)?.normalized ?? joinAbsolutePath(cwd, parsed.pathText)
  if (!absolutePath) {
    return null
  }

  return {
    absolutePath,
    line: parsed.line,
    column: parsed.column
  }
}

export function isPathInsideWorktree(filePath: string, worktreePath: string): boolean {
  const normalizedFile = normalizeAbsolutePath(filePath)
  const normalizedWorktree = normalizeAbsolutePath(worktreePath)
  if (
    !normalizedFile ||
    !normalizedWorktree ||
    normalizedFile.rootKind !== normalizedWorktree.rootKind
  ) {
    return false
  }
  if (normalizedFile.comparisonKey === normalizedWorktree.comparisonKey) {
    return true
  }
  return normalizedFile.comparisonKey.startsWith(`${normalizedWorktree.comparisonKey}/`)
}

export function toWorktreeRelativePath(filePath: string, worktreePath: string): string | null {
  const normalizedFile = normalizeAbsolutePath(filePath)
  const normalizedWorktree = normalizeAbsolutePath(worktreePath)
  if (
    !normalizedFile ||
    !normalizedWorktree ||
    normalizedFile.rootKind !== normalizedWorktree.rootKind
  ) {
    return null
  }
  if (normalizedFile.comparisonKey === normalizedWorktree.comparisonKey) {
    return ''
  }
  if (!normalizedFile.comparisonKey.startsWith(`${normalizedWorktree.comparisonKey}/`)) {
    return null
  }
  return normalizedFile.normalized.slice(normalizedWorktree.normalized.length + 1)
}
