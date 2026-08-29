import {
  parseFileLinkLocation,
  type ParsedFileLinkLocation
} from '../../../shared/file-link-location'
import {
  joinAbsolutePath,
  normalizeAbsolutePath,
  resolveTildePath
} from './terminal-path-normalization'

export type ParsedExplicitFileLinkTarget = ParsedFileLinkLocation

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
  const parsed = parseFileLinkLocation(value)
  if (!parsed) {
    return null
  }
  const { pathText, line, column } = parsed
  const hasLineOrColumn = line !== null || column !== null
  if (/^[\\/]\s/.test(pathText)) {
    return null
  }
  if (/[\\/]$/.test(pathText)) {
    const canKeepRelativeDirectory = options.allowRelativeDirectoryPath === true && !hasLineOrColumn
    if (hasLineOrColumn || (!canKeepRelativeDirectory && !canKeepTrailingSeparator(pathText))) {
      return null
    }
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
