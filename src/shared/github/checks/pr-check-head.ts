/** Only an immutable full commit ID can identify the provider read behind a check row. */
export function normalizePRCheckHeadSha(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
    ? value.toLowerCase()
    : undefined
}
