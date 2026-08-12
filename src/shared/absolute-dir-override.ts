import { isAbsolute } from 'node:path'

/**
 * Resolve an environment-provided directory override, ignoring non-absolute values.
 *
 * Why: a relative override (`.`, `..`, `rel/path`, or a drive-relative `C:foo`) resolves against
 * the main process cwd — `/` for a Finder- or Dock-launched app — and turns a scan root into an
 * unbounded walk of the whole disk (#13082).
 *
 * Note `isAbsolute` is syntactic only: `/..` is absolute and collapses to `/`. That is acceptable
 * for read-only discovery, but this helper is not an allowlist check.
 */
export function resolveAbsoluteDirOverride(
  value: string | undefined | null,
  fallback: string
): string {
  const trimmed = value?.trim() ?? ''
  return trimmed && isAbsolute(trimmed) ? trimmed : fallback
}
