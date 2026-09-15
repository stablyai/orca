import { posix, win32 } from 'node:path'

/**
 * An env-provided directory override, kept only when absolute (#13082).
 *
 * A relative value resolves against the *reading* process's cwd — `/` for a Finder-launched app,
 * the user data dir for the terminal daemon — never against the cwd the agent CLI used to write
 * it, so it names a different directory in every Orca process. Syntactic only: `/..` passes and
 * collapses to `/`, so this is not a containment check.
 */
export function resolveAbsoluteDirOverride(
  value: string | undefined | null,
  fallback: string,
  platform: NodeJS.Platform = process.platform
): string {
  const trimmed = value?.trim() ?? ''
  const isAbsolutePath = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute

  return trimmed && isAbsolutePath(trimmed) ? trimmed : fallback
}
