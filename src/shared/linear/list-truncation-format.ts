// Why: only Linear's search payloads carry totalCount; list connections report rows shown.
export function appendLinearListTruncation(
  body: string,
  shown: number,
  truncated: boolean,
  total?: number
): string {
  if (!truncated) {
    return body
  }
  return `${body}\ntruncated: showing ${shown}${total === undefined ? '' : ` of ${total}`}`
}
