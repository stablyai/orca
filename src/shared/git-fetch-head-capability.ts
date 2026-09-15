function gitErrorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return error instanceof Error ? error.message : String(error)
  }
  // Why flatMap: this module is Hermes-reachable via src/shared, which has no iterator helpers.
  return ['message', 'stderr', 'stdout']
    .flatMap((key) => {
      const value = (error as Record<string, unknown>)[key]
      return typeof value === 'string' ? [value] : []
    })
    .join('\n')
}

export function isNoWriteFetchHeadUnsupportedError(error: unknown): boolean {
  const output = gitErrorText(error)
  return /(?:unknown|invalid|unrecognized) option(?::\s*|\s+)[`']?(?:--?)?no-write-fetch-head[`']?(?:\s|$)/i.test(
    output
  )
}
