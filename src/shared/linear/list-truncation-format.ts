// Why: the count is a row count, not a total — Linear's issues() connection has no totalCount.
export function appendLinearListTruncation(
  body: string,
  shown: number,
  truncated: boolean
): string {
  return truncated ? `${body}\ntruncated: showing ${shown}` : body
}
