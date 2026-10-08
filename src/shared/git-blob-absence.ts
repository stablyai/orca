import { readGitCommandFailureStderr, readGitCommandFailureText } from './git-command-failure-text'

/** A missing path diagnostic proves absence; exit 128 alone also covers corrupt objects. */
export function isMissingGitBlobPath(error: unknown, filePath: string, oid?: string): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 128) {
    return false
  }
  const text = readGitCommandFailureStderr(error) ?? readGitCommandFailureText(error)
  const diagnostic = text.trim().replace(/^fatal: Path /, 'fatal: path ')
  const prefix = `fatal: path '${filePath}' `
  const endings =
    oid === undefined
      ? [
          'exists on disk, but not in the index',
          'does not exist (neither on disk nor in the index)'
        ]
      : [`exists on disk, but not in '${oid}'`, `does not exist in '${oid}'`]
  return endings.some(
    (ending) => diagnostic === `${prefix}${ending}` || diagnostic === `${prefix}${ending}.`
  )
}
