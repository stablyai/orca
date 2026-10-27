import { posix, win32 } from 'node:path'

/** Require absolute overrides: relative paths resolve against each reader's cwd, not the writer's (#13082). Syntax only; /.. passes, so this proves no containment. */
export function resolveAbsoluteDirOverride(
  value: string | undefined | null,
  fallback: string,
  platform: NodeJS.Platform = process.platform
): string {
  const trimmed = value?.trim() ?? ''
  const isAbsolutePath = platform === 'win32' ? win32.isAbsolute : posix.isAbsolute
  return trimmed && isAbsolutePath(trimmed) ? trimmed : fallback
}
