export type RetiredPtyIncarnation = {
  incarnationId: string
  code: number
  expiresAt: number
}

const MAX_RETIRED_PTY_INCARNATIONS = 1000

/** Drop expired exit evidence and cap retained records during long-lived hosts. */
export function pruneRetiredPtyIncarnations(
  records: Map<string, RetiredPtyIncarnation>,
  now = Date.now()
): void {
  for (const [id, record] of records) {
    if (record.expiresAt <= now) {
      records.delete(id)
    }
  }
  while (records.size > MAX_RETIRED_PTY_INCARNATIONS) {
    const oldest = records.keys().next().value
    if (oldest === undefined) {
      break
    }
    records.delete(oldest)
  }
}
