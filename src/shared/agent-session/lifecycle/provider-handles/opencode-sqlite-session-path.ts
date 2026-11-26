const OPENCODE_SQLITE_PATH_SEPARATOR = '#'

/** Agents whose Session History rows are `<database>#<session id>` references into one SQLite store. */
export type SqliteSessionAgent = 'opencode' | 'opencode2' | 'zcode' | 'hermes'

export function buildOpenCodeSqliteCandidatePath(dbPath: string, sessionId: string): string {
  return `${dbPath}${OPENCODE_SQLITE_PATH_SEPARATOR}${sessionId}`
}

// A database row reference is metadata, never a transcript file path.
export function splitOpenCodeSqliteCandidate(
  candidatePath: string,
  agent: SqliteSessionAgent = 'opencode'
): { dbPath: string; sessionId: string } | null {
  const separatorIndex = candidatePath.lastIndexOf(OPENCODE_SQLITE_PATH_SEPARATOR)
  if (separatorIndex <= 0 || separatorIndex === candidatePath.length - 1) {
    return null
  }
  const dbPath = candidatePath.slice(0, separatorIndex)
  const sessionId = candidatePath.slice(separatorIndex + 1)
  // Host paths may use either separator when consumed by a browser client.
  const databaseName = dbPath.split(/[\\/]/).at(-1) ?? ''
  const validName =
    agent === 'zcode'
      ? databaseName.toLowerCase() === 'db.sqlite'
      : agent === 'hermes'
        ? databaseName.toLowerCase() === 'state.db'
        : /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/i.test(databaseName)
  return validName ? { dbPath, sessionId } : null
}

export function looksLikeOpenCodeSqliteCandidate(candidatePath: string): boolean {
  return splitOpenCodeSqliteCandidate(candidatePath) !== null
}
