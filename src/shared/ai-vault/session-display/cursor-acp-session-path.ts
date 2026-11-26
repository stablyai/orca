const ACP_STORE_PATH = /[\\/]acp-sessions[\\/][^\\/]+[\\/]store\.db$/

/** `cursor-agent acp` keeps each chat in acp-sessions/<id>/; History names its store.db, which it
 *  only stats: the conversation inside is unreadable, and no CLI resumes it. */
export function isCursorAcpSessionStorePath(filePath: string): boolean {
  return ACP_STORE_PATH.test(filePath)
}

export function isCursorAcpSessionRow(row: { agent: string; filePath: string }): boolean {
  return row.agent === 'cursor' && isCursorAcpSessionStorePath(row.filePath)
}

/** History cannot count a Cursor ACP conversation, so its row shows no count rather than 0. */
export function aiVaultSessionMessageCountKnown(row: { agent: string; filePath: string }): boolean {
  return !isCursorAcpSessionRow(row)
}
