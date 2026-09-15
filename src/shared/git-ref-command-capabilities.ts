function getGitErrorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return error instanceof Error ? error.message : String(error)
  }
  // Hermes has no iterator helpers, so keep the single pass in flatMap.
  const values = ['message', 'stderr', 'stdout'].flatMap((key) => {
    const value = (error as Record<string, unknown>)[key]
    return typeof value === 'string' ? [value] : []
  })
  return values.join('\n')
}

export function isForEachRefExcludeUnsupportedError(error: unknown): boolean {
  const output = getGitErrorText(error).toLowerCase()
  return output.includes('unknown option') && output.includes('exclude')
}
