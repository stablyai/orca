function getGitErrorText(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return error instanceof Error ? error.message : String(error)
  }
  const values = ['message', 'stderr', 'stdout']
    .map((key) => (error as Record<string, unknown>)[key])
    .filter((value): value is string => typeof value === 'string')
  return values.join('\n')
}

export function isUnsupportedMergeTreeWriteTreeError(error: unknown): boolean {
  const output = getGitErrorText(error)
  return (
    /(?:unknown|invalid|unrecognized) option(?::|\s+)[`']?(?:--?)?write-tree[`']?(?:\s|$)/i.test(
      output
    ) ||
    /unknown rev [`']?--write-tree[`']?(?:\s|$)/i.test(output) ||
    /usage:\s*git merge-tree\s+<base-tree>\s+<branch1>\s+<branch2>/i.test(output)
  )
}

export function isUnsupportedMergeTreeMergeBaseError(error: unknown): boolean {
  const output = getGitErrorText(error)
  return /(?:unknown|invalid|unrecognized) option(?::|\s+)[`']?(?:--?)?merge-base[`']?(?:\s|$)/i.test(
    output
  )
}
