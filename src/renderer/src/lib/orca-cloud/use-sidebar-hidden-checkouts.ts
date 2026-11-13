import { useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  readHiddenVmCheckouts,
  subscribeHiddenVmCheckouts,
  withOrcaCloudHosts,
  type HiddenVmCheckouts
} from '@/runtime/ephemeral-vm/vm-create-hidden-checkouts'
import { getRepoExecutionHostId, toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { orcaCloudAccountId } from '../../../../shared/hosted-sandbox/orca-cloud-account'
import { isOrcaCloudRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import type { Repo } from '../../../../shared/repo-types'

type CloudScopeState = Pick<AppState, 'runtimeEnvironments'> &
  Partial<Pick<AppState, 'orcaProfileAuthStatus' | 'cloudAccountIdByEnvironmentId'>>

/**
 * Every Orca Cloud server this desktop runs, `+host` when the active team owns it and `-host`
 * otherwise (another team's, or one whose team is not known yet). Newline-joined so the selector
 * compares by value.
 *
 * A PAIRED server (`orcaCloudPaired`, PAIRED-NO-ROW) of the active account is left out: its owner is
 * never in `cloudAccountIdByEnvironmentId` (that knows this desktop's own runtimes only), and its
 * primary checkout IS the workspace's row, so either treatment would hide a workspace this desktop
 * just paired with, a GitHub-only create included. A paired server stamped with ANOTHER account
 * (PAIRED-ACCOUNT-FILTER) is `-host`, like another team's owned sandbox; one saved before pairings
 * were stamped stays visible until the prune stamps it from the active team's list.
 */
export function selectOrcaCloudHostScopeKey(state: CloudScopeState): string {
  const active = orcaCloudAccountId(state.orcaProfileAuthStatus?.cloud)
  const owners = state.cloudAccountIdByEnvironmentId ?? {}
  return (state.runtimeEnvironments ?? [])
    .filter((environment) => isOrcaCloudRuntimeEnvironment(environment))
    .flatMap((environment) => {
      const hostId = toRuntimeExecutionHostId(environment.id)
      if (environment.orcaCloudPaired === true) {
        const account = environment.orcaCloudPairedAccountId
        return account && account !== active ? [`-${hostId}`] : []
      }
      const inTeam = active !== null && owners[environment.id] === active
      return [`${inTeam ? '+' : '-'}${hostId}`]
    })
    .join('\n')
}

export function parseOrcaCloudHostScopeKey(key: string): {
  primaryHostIds: ReadonlySet<string>
  hiddenHostIds: ReadonlySet<string>
} {
  const primaryHostIds = new Set<string>()
  const hiddenHostIds = new Set<string>()
  for (const entry of key ? key.split('\n') : []) {
    ;(entry.startsWith('+') ? primaryHostIds : hiddenHostIds).add(entry.slice(1))
  }
  return { primaryHostIds, hiddenHostIds }
}

/**
 * What sidebar lists hide: VM checkouts whose create is in progress, an Orca Cloud clone beside its
 * listed workspace, and every row of another team's sandbox.
 */
export function useSidebarHiddenCheckouts(): HiddenVmCheckouts {
  const pending = useSyncExternalStore(subscribeHiddenVmCheckouts, readHiddenVmCheckouts)
  const scopeKey = useAppStore(selectOrcaCloudHostScopeKey)
  return useMemo(
    () => withOrcaCloudHosts(pending, parseOrcaCloudHostScopeKey(scopeKey)),
    [pending, scopeKey]
  )
}

/** Repos without another team's sandbox projects, so none surfaces as its own project header. */
export function withoutHiddenHostRepos<R extends Pick<Repo, 'connectionId' | 'executionHostId'>>(
  repos: readonly R[],
  checkouts: HiddenVmCheckouts
): readonly R[] {
  const hidden = checkouts.hiddenHostIds
  if (!hidden?.size) {
    return repos
  }
  const kept = repos.filter((repo) => !hidden.has(getRepoExecutionHostId(repo)))
  return kept.length === repos.length ? repos : kept
}

/** The store's repos scoped like the sidebar's rows (useSidebarHiddenCheckouts). */
export function useSidebarScopedRepos(): readonly Repo[] {
  const repos = useAppStore((state) => state.repos)
  const hidden = useSidebarHiddenCheckouts()
  return useMemo(() => withoutHiddenHostRepos(repos, hidden), [repos, hidden])
}
