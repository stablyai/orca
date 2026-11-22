/** Read message/stderr/stdout: execFile duplicates stderr in message, while Orca’s dirty-removal errors attach status output to stdout.
 * Classifiers must agree across both shapes. Real Git refusals use error()/die() on stderr (2.25–2.55). */
export function readGitCommandFailureText(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return String(error)
  }
  const parts: string[] = []
  for (const field of ['message', 'stderr', 'stdout'] as const) {
    const value = (error as Record<string, unknown>)[field]
    if (typeof value === 'string' && value) {
      parts.push(value)
    }
  }
  return parts.join('\n')
}

export function readGitCommandFailureStderr(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) {
    return null
  }
  if (typeof error.stderr === 'string') {
    return error.stderr
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(error.stderr)) {
    return error.stderr.toString('utf8')
  }
  return null
}
