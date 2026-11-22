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
  const match = /^(?:L|line-?)(\d+)(?:C(\d+))?(?:-(?:L|line-?)?\d+(?:C\d+)?)?$/i.exec(trimmed)
  if (!match) {
    return null
  }
  const line = Number(match[1])
  const column = match[2] ? Number(match[2]) : null
  if (line < 1 || (column !== null && column < 1)) {
    return null
  }
  return {
    line,
    column
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

function parseFilePathTrailingLineTarget(filePath: string): TerminalFileUrlTarget | null {
  const match = /^(.*?)(?::(\d+))(?::(\d+))?$/.exec(filePath)
  if (!match || !match[1] || match[1].endsWith('/') || match[1].endsWith('\\')) {
    return null
  }
  return {
    filePath: match[1],
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

  const filePath = fileUriToFilesystemPath(parsed)
  if (!filePath) {
    return null
  }

  const hashTarget = parseFileUrlLineHash(parsed.hash)
  if (hashTarget) {
    return { filePath, line: hashTarget.line, column: hashTarget.column }
  }

  return parseFilePathTrailingLineTarget(filePath) ?? { filePath, line: null, column: null }
}
