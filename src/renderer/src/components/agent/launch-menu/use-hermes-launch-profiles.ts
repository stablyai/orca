import { useEffect, useState } from 'react'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import {
  HERMES_PROFILE_NAME,
  hasHermesProfileArg,
  withHermesProfileArgs
} from '../../../../../shared/agent-launch/startup/hermes-profile'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { HermesLaunchProfiles } from '../../../../../shared/hermes/hermes-launch-profiles'

/** One answer per pane host: the local install, a WSL distro or an SSH target. */
const cacheByHost = new Map<string, HermesLaunchProfiles>()
const CACHE_LIMIT = 16

function cacheKey(executionHostId: string | undefined, worktreeId: string | undefined): string {
  return `${executionHostId ?? 'local'}\0${worktreeId ?? ''}`
}

function fetchHermesLaunchProfiles(
  executionHostId: string | undefined,
  worktreeId: string | undefined
): Promise<HermesLaunchProfiles | null> {
  const cached = cacheByHost.get(cacheKey(executionHostId, worktreeId))
  if (cached) {
    return Promise.resolve(cached)
  }
  if (isWebClientLocation()) {
    return Promise.resolve(null)
  }
  // Failures stay uncached: a connecting SSH host answers on the next menu open.
  return window.api.hermes
    .launchProfiles({ executionHostId, worktreeId })
    .then((profiles) => {
      if (profiles && profiles.profiles.length > 0) {
        if (cacheByHost.size >= CACHE_LIMIT) {
          cacheByHost.clear()
        }
        cacheByHost.set(cacheKey(executionHostId, worktreeId), profiles)
      }
      return profiles
    })
    .catch((error: unknown) => {
      // A refused host answers again on the next menu open; say why instead of hiding silently.
      console.warn('[hermes] launchProfiles request failed', { executionHostId, worktreeId }, error)
      return null
    })
}

/** Profiles for the Hermes launch submenu, fetched once per pane host; null until known. */
export function useHermesLaunchProfiles(
  enabled: boolean,
  /** An ExecutionHostId from menu rows, or a picker entry's looser host string. */
  executionHostId: string | undefined,
  worktreeId: string | undefined
): HermesLaunchProfiles | null {
  const key = enabled ? cacheKey(executionHostId, worktreeId) : null
  const [profiles, setProfiles] = useState<HermesLaunchProfiles | null>(
    key ? (cacheByHost.get(key) ?? null) : null
  )
  useEffect(() => {
    if (!key) {
      return
    }
    const cached = cacheByHost.get(key)
    if (cached) {
      setProfiles(cached)
      return
    }
    let cancelled = false
    void fetchHermesLaunchProfiles(executionHostId, worktreeId).then((next) => {
      if (!cancelled && next && next.profiles.length > 0) {
        setProfiles(next)
      }
    })
    return () => {
      cancelled = true
    }
    // The key dedupes fetches; the request fields satisfy exhaustive-deps and are stable strings.
  }, [key, executionHostId, worktreeId])
  return profiles
}

/** Profiles live where Hermes runs: the local machine (including its WSL distros) and SSH hosts. */
export function hermesProfileSubmenuApplies(executionHostId: ExecutionHostId | undefined): boolean {
  const kind = executionHostId === undefined ? 'local' : parseExecutionHostId(executionHostId)?.kind
  return kind === 'local' || kind === 'ssh'
}

/** `--profile <id>` folded into the pane's Arguments; null keeps the caller's own text.
 *  A profile flag already present is a choice typed in Settings or the picker, so it wins. */
export function hermesProfileLaunchArgs(baseArgs: string, profile: string): string | null {
  if (!HERMES_PROFILE_NAME.test(profile) || hasHermesProfileArg(baseArgs)) {
    return null
  }
  return withHermesProfileArgs(baseArgs, profile)
}
