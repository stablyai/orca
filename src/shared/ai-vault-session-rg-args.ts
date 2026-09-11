export const AI_VAULT_SESSION_RG_MAX_FILESIZE = '8M'
export const AI_VAULT_SESSION_RG_TIMEOUT_MS = 12_000
export const AI_VAULT_SESSION_RG_MAX_TARGETS = 500

/**
 * Build the complete rg argv for Session History transcript search.
 * Callers spawn `rg` with this array as-is via the existing wsl-aware helper.
 */
export function buildAiVaultSessionRgArgs(query: string, targets: readonly string[]): string[] {
  return [
    '--files-with-matches',
    '--hidden',
    '--no-ignore',
    '--ignore-case',
    '--fixed-strings',
    '--max-filesize',
    AI_VAULT_SESSION_RG_MAX_FILESIZE,
    '--',
    query,
    ...targets
  ]
}

export function lastPathSeparator(filePath: string): { index: number; separator: string } {
  const slash = filePath.lastIndexOf('/')
  const backslash = filePath.lastIndexOf('\\')
  if (slash === -1 && backslash === -1) {
    return { index: -1, separator: '/' }
  }
  return slash > backslash
    ? { index: slash, separator: '/' }
    : { index: backslash, separator: '\\' }
}

export function siblingTranscriptPath(filePath: string, fileName: string): string {
  const { index, separator } = lastPathSeparator(filePath)
  const directory = index === -1 ? filePath : filePath.slice(0, index)
  return `${directory}${separator}${fileName}`
}

export function parentTranscriptDirectory(filePath: string): string {
  const { index } = lastPathSeparator(filePath)
  return index === -1 ? '.' : filePath.slice(0, index)
}

export function isSqliteSessionPath(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return lower.endsWith('.db') || lower.endsWith('.sqlite') || lower.endsWith('.sqlite3')
}

export function aiVaultSessionRgTargets(session: { agent: string; filePath: string }): string[] {
  if (!session.filePath || isSqliteSessionPath(session.filePath)) {
    return []
  }
  const targets = [session.filePath]
  if (session.agent === 'grok') {
    targets.push(siblingTranscriptPath(session.filePath, 'chat_history.jsonl'))
  }
  return targets
}
