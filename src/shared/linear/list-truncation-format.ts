// List connections usually expose only row counts; search callers may supply a provider total.
export function appendLinearListTruncation(
  body: string,
  shown: number,
  truncated: boolean,
  totalCount?: number
): string {
  if (!truncated) {
    return body
  }
  const total = totalCount === undefined ? '' : ` of ${totalCount}`
  return `${body}\ntruncated: showing ${shown}${total}`
}
