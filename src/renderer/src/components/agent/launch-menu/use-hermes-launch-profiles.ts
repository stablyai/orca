import { useEffect, useState } from 'react'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { HERMES_PROFILE_NAME } from '../../../../../shared/agent-launch/startup/hermes-profile'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { isLocalExecutionHost } from '../../../../../shared/execution-host/execution-host'
import type { HermesLaunchProfiles } from '../../../../../shared/hermes/hermes-launch-profiles'

let cachedProfiles: HermesLaunchProfiles | null = null
let inflight: Promise<HermesLaunchProfiles | null> | null = null

/** Desktop only: the web client's filesystem has no Hermes home, and it answers null. */
function fetchHermesLaunchProfiles(): Promise<HermesLaunchProfiles | null> {
  if (cachedProfiles) {
    return Promise.resolve(cachedProfiles)
  }
  inflight ??= isWebClientLocation()
    ? Promise.resolve(null)
    : window.api.hermes.launchProfiles().then(
        (profiles) => (cachedProfiles = profiles),
        () => null
      )
  return inflight
}

/** Profiles for the Hermes launch submenu, fetched once per renderer; null until known or on web. */
export function useHermesLaunchProfiles(enabled: boolean): HermesLaunchProfiles | null {
  const [profiles, setProfiles] = useState<HermesLaunchProfiles | null>(cachedProfiles)
  useEffect(() => {
    if (!enabled || cachedProfiles) {
      return
    }
    let cancelled = false
    void fetchHermesLaunchProfiles().then((next) => {
      if (!cancelled && next) {
        setProfiles(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return profiles
}

/** Profiles live on the machine that runs Hermes, so only a local pane's row offers the submenu. */
export function hermesProfileSubmenuApplies(executionHostId: ExecutionHostId | undefined): boolean {
  return isLocalExecutionHost(executionHostId)
}

/** `--profile <id>` folded into the pane's Arguments; null keeps the caller's own text.
 *  A profile flag already present is a choice typed in Settings or the picker, so it wins. */
export function hermesProfileLaunchArgs(baseArgs: string, profile: string): string | null {
  if (!HERMES_PROFILE_NAME.test(profile)) {
    return null
  }
  const trimmed = baseArgs.trim()
  if (/(^|\s)--profile(\s|=|$)/.test(trimmed) || /(^|\s)-p\s/.test(trimmed)) {
    return null
  }
  return trimmed ? `${trimmed} --profile ${profile}` : `--profile ${profile}`
}
