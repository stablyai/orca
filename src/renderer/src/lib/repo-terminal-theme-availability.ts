import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import {
  normalizeRepoTerminalThemeOverrides,
  type RepoTerminalThemeOverrides
} from '../../../shared/repo-terminal-theme'

export type RepoTerminalThemeAvailability = 'available' | 'runtime-host'

/** Why runtime is hidden: the row lives on the paired server, where an older schema strips the field and the pick silently reverts. */
export function getRepoTerminalThemeAvailability(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): RepoTerminalThemeAvailability {
  return parseExecutionHostId(getRepoExecutionHostId(repo))?.kind === 'runtime'
    ? 'runtime-host'
    : 'available'
}

// null = normalizes to nothing. Keyed by the stored object so repeat reads return the same reference.
const normalizedThemeByStoredValue = new WeakMap<object, RepoTerminalThemeOverrides | null>()

function normalizeStoredRepoTerminalTheme(
  stored: Repo['terminalTheme']
): RepoTerminalThemeOverrides | undefined {
  // Why runtime-checked: runtime rows arrive over RPC unvalidated, typed or not.
  if (!stored || typeof stored !== 'object') {
    return undefined
  }
  let normalized = normalizedThemeByStoredValue.get(stored)
  if (normalized === undefined) {
    const next = normalizeRepoTerminalThemeOverrides(stored)
    normalized =
      next && next.dark === stored.dark && next.light === stored.light ? stored : (next ?? null)
    normalizedThemeByStoredValue.set(stored, normalized)
  }
  return normalized ?? undefined
}

/** The theme a row's terminals apply: none where the settings section cannot edit it, and
 *  malformed values (other builds' runtime rows) fall back to global instead of throwing. */
export function getApplicableRepoTerminalTheme(
  repo: Pick<Repo, 'connectionId' | 'executionHostId' | 'terminalTheme'>
): RepoTerminalThemeOverrides | undefined {
  if (getRepoTerminalThemeAvailability(repo) !== 'available') {
    return undefined
  }
  return normalizeStoredRepoTerminalTheme(repo.terminalTheme)
}
