import { readIpcErrorDetail, readIpcErrorMessage } from '@/runtime/errors/ipc-error'

const GIT_REASON_LINE = /^(?:fatal|error):/i

/**
 * Off macOS, captured Git errors read "Command failed: <cmd>\n<stderr>", so the first line hides
 * git's own reason (e.g. the index.lock "File exists"); show the stderr line the user can act on.
 */
export function readGitCommandFailureMessage(error: unknown): string | undefined {
  const firstLine = readIpcErrorMessage(error)
  if (!firstLine?.startsWith('Command failed:')) {
    return firstLine
  }
  let fallback: string | undefined
  for (const rawLine of (readIpcErrorDetail(error) ?? '').split('\n').slice(1)) {
    const line = rawLine.trim()
    if (GIT_REASON_LINE.test(line)) {
      return line
    }
    fallback ||= line
  }
  return fallback || firstLine
}
