export type TerminalFileUrlTarget = {
  filePath: string
  line: number | null
  column: number | null
}

function parseFileUrlLineHash(hash: string): { line: number; column: number | null } | null {
  const trimmed = hash.startsWith('#') ? hash.slice(1) : hash
  const match = /^L(\d+)(?:C(\d+))?$/i.exec(trimmed)
  if (!match) {
    return null
  }
  return {
    line: Number(match[1]),
    column: match[2] ? Number(match[2]) : null
  }
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

export function resolveTerminalFileUrlTarget(parsed: URL): TerminalFileUrlTarget | null {
  if (parsed.hostname && parsed.hostname !== 'localhost') {
    return null
  }

  let filePath = decodeURIComponent(parsed.pathname)
  // Why: on Windows, file:///C:/foo yields pathname "/C:/foo". The leading
  // slash must be stripped to produce a valid Windows path ("C:/foo").
  if (/^\/[A-Za-z]:/.test(filePath)) {
    filePath = filePath.slice(1)
  }

  const hashTarget = parseFileUrlLineHash(parsed.hash)
  if (hashTarget) {
    return { filePath, line: hashTarget.line, column: hashTarget.column }
  }

  return parseFilePathTrailingLineTarget(filePath) ?? { filePath, line: null, column: null }
}
