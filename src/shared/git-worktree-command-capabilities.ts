function getGitErrorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return error instanceof Error ? error.message : String(error)
  }
  const values = ['message', 'stderr', 'stdout']
    .map((key) => (error as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === 'string')
  return values.join('\n')
}

function getGitErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

export function isUnsupportedWorktreeListZError(error: unknown): boolean {
  // `-z` is this fixed command's only post-baseline flag, so exit 129 is the
  // locale-independent rejection signal on old native, WSL, and SSH Git.
  if (getGitErrorCode(error) === '129') {
    return true
  }
  return /(?:unknown|invalid|unrecognized) (?:switch|option).*`?-?z'?/i.test(getGitErrorText(error))
}

export function isUnsupportedRevParsePathFormatError(error: unknown): boolean {
  return /(?:unknown|invalid|unrecognized).*(?:--path-format|path-format)/i.test(
    getGitErrorText(error)
  )
}

export function hasUnsupportedRevParsePathFormatEcho(output: string): boolean {
  return output.split(/\r?\n/).some((line) => line.startsWith('--path-format'))
}
