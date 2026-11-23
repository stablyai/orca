const ACP_STORE_PATH = /[\\/]acp-sessions[\\/][^\\/]+[\\/]store\.db$/

/** `cursor-agent acp` keeps each chat in acp-sessions/<id>/; History names its store.db, which it
 *  only stats: the conversation inside is unreadable, and no CLI resumes it. */
export function isCursorAcpSessionStorePath(filePath: string): boolean {
  return ACP_STORE_PATH.test(filePath)
}

export function isCursorAcpSessionRow(row: { agent: string; filePath: string }): boolean {
  return row.agent === 'cursor' && isCursorAcpSessionStorePath(row.filePath)
}

export function isAiVaultJournalOnlySession(row: { agent: string; filePath: string }): boolean {
  return isCursorAcpSessionRow(row) || (row.agent === 'mimo-code' && row.filePath === '')
}

/** History cannot count a conversation whose complete journal it has not read. */
export function aiVaultSessionMessageCountKnown(row: { agent: string; filePath: string }): boolean {
  return !isAiVaultJournalOnlySession(row)
}
