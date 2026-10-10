function gitErrorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return error instanceof Error ? error.message : String(error)
  }
  return ['message', 'stderr', 'stdout']
    .map((key) => (error as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
}

export function isNoWriteFetchHeadUnsupportedError(error: unknown): boolean {
  const output = gitErrorText(error)
  return /(?:unknown|invalid|unrecognized) option(?::\s*|\s+)[`']?(?:--?)?no-write-fetch-head[`']?(?:\s|$)/i.test(
    output
  )
}
