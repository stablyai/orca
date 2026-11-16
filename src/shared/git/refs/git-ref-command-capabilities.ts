function getGitErrorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return error instanceof Error ? error.message : String(error)
  }
  const values = ['message', 'stderr', 'stdout']
    .map((key) => (error as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === 'string')
  return values.join('\n')
}

export function isForEachRefExcludeUnsupportedError(error: unknown): boolean {
  const output = getGitErrorText(error).toLowerCase()
  return output.includes('unknown option') && output.includes('exclude')
}
