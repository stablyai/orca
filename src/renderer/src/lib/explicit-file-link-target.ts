import {
  joinAbsolutePath,
  normalizeAbsolutePath,
  resolveTildePath
} from './terminal-path-normalization'

export type ParsedExplicitFileLinkTarget = {
  pathText: string
  line: number | null
  column: number | null
}

export type ResolvedExplicitFileLinkTarget = Pick<
  ParsedExplicitFileLinkTarget,
  'line' | 'column'
> & {
  absolutePath: string
}

type ParseExplicitFileLinkTargetOptions = {
  allowRelativeDirectoryPath?: boolean
}

function canKeepTrailingSeparator(pathText: string): boolean {
  // Why: bare roots ("/", "~/", "C:/") are ambiguous link targets, while
  // absolute/tilde paths with a real segment are unambiguous directories.
  if (/^[\\/]+$/.test(pathText) || /^~[\\/]$/.test(pathText) || /^[A-Za-z]:[\\/]$/.test(pathText)) {
    return false
  }
  return /^(?:~[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(pathText)
}

export function parseExplicitFileLinkTarget(
  value: string,
  options: ParseExplicitFileLinkTargetOptions = {}
): ParsedExplicitFileLinkTarget | null {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value)
  if (!match) {
    return null
  }
  const pathText = match[1]
  const hasLineOrColumn = Boolean(match[2] || match[3])
  if (!pathText) {
    return null
  }
  if (/^[\\/]\s/.test(pathText)) {
    return null
  }
  if (/[\\/]$/.test(pathText)) {
    const canKeepRelativeDirectory = options.allowRelativeDirectoryPath === true && !hasLineOrColumn
    if (hasLineOrColumn || (!canKeepRelativeDirectory && !canKeepTrailingSeparator(pathText))) {
      return null
    }
  }

  const line = match[2] ? Number.parseInt(match[2], 10) : null
  const column = match[3] ? Number.parseInt(match[3], 10) : null
  if ((line !== null && line < 1) || (column !== null && column < 1)) {
    return null
  }

  return { pathText, line, column }
}

export function resolveExplicitFileLinkTargetPath(
  pathText: string,
  cwd: string,
  homePath?: string | null
): string | null {
  if (/^~[\\/]/.test(pathText)) {
    return resolveTildePath(pathText, cwd, homePath)
  }
  return normalizeAbsolutePath(pathText)?.normalized ?? joinAbsolutePath(cwd, pathText)
}

export function resolveExplicitFileLinkTarget(
  parsed: ParsedExplicitFileLinkTarget,
  cwd: string,
  homePath?: string | null
): ResolvedExplicitFileLinkTarget | null {
  const absolutePath = resolveExplicitFileLinkTargetPath(parsed.pathText, cwd, homePath)
  if (!absolutePath) {
    return null
  }

  return {
    absolutePath,
    line: parsed.line,
    column: parsed.column
  }
}
