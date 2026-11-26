import { fileUriToFilesystemPath } from '../../file-links/file-uri-path'

export type TerminalFileUrlTarget = {
  filePath: string
  line: number | null
  column: number | null
}

export type TerminalFileUrlTargetOptions = {
  allowUncHost?: boolean
}

type LineHashLocation = { line: number; column: number | null }

function parseFileUrlLineHash(hash: string): LineHashLocation | null {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash
  // Why: a `#L11-L13` or `#L11-13` range opens at its first line.
  const match = /^L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i.exec(trimmed)
  if (!match) {
    return null
  }
  return {
    line: Number(match[1]),
    column: match[2] ? Number(match[2]) : null
  }
}

/** Splits a trailing `#L<line>` fragment off a plain path; other `#` stay filename characters. */
export function splitPathLineHash(
  pathText: string
): ({ pathText: string } & LineHashLocation) | null {
  const hashIndex = pathText.lastIndexOf('#')
  const location = hashIndex > 0 ? parseFileUrlLineHash(pathText.slice(hashIndex)) : null
  return location ? { pathText: pathText.slice(0, hashIndex), ...location } : null
}

function parseEncodedPathnameLineTarget(
  parsed: URL
): { baseUrl: URL; line: number; column: number | null } | null {
  // Why: inspect raw pathname before decodeURIComponent so encoded %3A stays filename content.
  const match = /^(.*?)(?::(\d+))(?::(\d+))?$/.exec(parsed.pathname)
  if (!match || !match[1]) {
    return null
  }
  const baseUrl = new URL(parsed.href)
  baseUrl.pathname = match[1]
  return {
    baseUrl,
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : null
  }
}

export function resolveTerminalFileUrlTarget(
  parsed: URL,
  options: TerminalFileUrlTargetOptions = {}
): TerminalFileUrlTarget | null {
  if (parsed.hostname && parsed.hostname !== 'localhost' && !options.allowUncHost) {
    return null
  }

  const hashTarget = parseFileUrlLineHash(parsed.hash)
  if (hashTarget) {
    const filePath = fileUriToFilesystemPath(parsed)
    return filePath ? { filePath, line: hashTarget.line, column: hashTarget.column } : null
  }

  const trailingTarget = parseEncodedPathnameLineTarget(parsed)
  if (trailingTarget) {
    const basePath = fileUriToFilesystemPath(trailingTarget.baseUrl)
    if (basePath && !basePath.endsWith('/') && !basePath.endsWith('\\')) {
      return {
        filePath: basePath,
        line: trailingTarget.line,
        column: trailingTarget.column
      }
    }
  }

  const filePath = fileUriToFilesystemPath(parsed)
  if (!filePath) {
    return null
  }

  return { filePath, line: null, column: null }
}
