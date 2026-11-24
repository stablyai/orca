/** Rows that are not part of the conversation but happened during it, such as a worker's approval:
 *  the message each follows is the last dated one at or before its time; null when no message is
 *  dated. A row older than every loaded message waits for the history it belongs to. */
export function anchorNativeChatTimedRows(
  dated: readonly { id: string; at: number }[],
  rows: readonly { key: string; at: number }[]
): [key: string, messageId: string | null][] {
  return rows
    .toSorted((a, b) => a.at - b.at)
    .flatMap((row): [string, string | null][] => {
      const anchor = dated.findLast((message) => message.at <= row.at)?.id ?? null
      return anchor === null && dated.length > 0 ? [] : [[row.key, anchor]]
    })
}
