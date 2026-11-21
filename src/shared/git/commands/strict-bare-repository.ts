import { findGitSubcommandIndex } from './git-command-classification'
import { readGitCommandFailureStderr } from './git-command-failure-text'

/** Git setup dies with this exact line before the subcommand runs. */
const STRICT_BARE_REPOSITORY_REFUSAL =
  /^fatal: cannot use bare repository '.*' \(safe\.bareRepository is 'explicit'\)$/

/**
 * Implicit discovery of a bare repository is refused when safe.bareRepository=explicit.
 * The refusal happens before the subcommand, so one `--git-dir=.` retry is safe.
 * An existing `--git-dir` is left alone, and any other stderr is not retried.
 */
export function strictBareRepositoryRetryArgs(
  args: readonly string[],
  error: unknown
): string[] | null {
  const stderr = readGitCommandFailureStderr(error)
  if (stderr === null) {
    return null
  }
  const lines = stderr.split(/[\r\n]+/).filter((line) => line.length > 0)
  if (lines.length !== 1 || !STRICT_BARE_REPOSITORY_REFUSAL.test(lines[0])) {
    return null
  }
  if (args.some((arg) => arg === '--git-dir' || arg.startsWith('--git-dir='))) {
    return null
  }
  const subcommandIndex = findGitSubcommandIndex(args)
  if (subcommandIndex < 0) {
    return null
  }
  return [...args.slice(0, subcommandIndex), '--git-dir=.', ...args.slice(subcommandIndex)]
}

/** Replay only the exact setup refusal, after the failed attempt has already released its admission. */
export function retryStrictBareRepository<T>(
  args: readonly string[],
  attempted: Promise<T>,
  retry: (retryArgs: string[]) => Promise<T>
): Promise<T> {
  return attempted.catch((error: unknown) => {
    const retryArgs = strictBareRepositoryRetryArgs(args, error)
    if (!retryArgs) {
      throw error
    }
    return retry(retryArgs)
  })
}
