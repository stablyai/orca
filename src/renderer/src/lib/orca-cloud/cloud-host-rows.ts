// Which sidebar rows are Orca Cloud workspaces, including PAIRED ones (CLOUD-PRIMARY-DELETE).
// `useIsCloudWorkspace` knows only the workspaces this desktop created. A workspace opened from Home
// on another desktop (or after a re-sign-in) is paired: a "<name> (cloud)" server whose rows live on
// `runtime:<environmentId>`. Two sources, either is enough:
// - the runtime catalog: main marks a paired server `orcaCloudPaired` (PAIRED-AWARE), so
//   `isOrcaCloudRuntimeEnvironment` knows it synchronously, with no priming (a row created from a
//   GitHub-only repo is paired from birth and must lose its "primary" badge at once);
// - the cloud identity store, which also maps the row to its sandbox id (for Delete and Sleep).
//
// A cloud row on the sandbox's own checkout (isMainWorktree) IS the cloud workspace, not a local
// repo's primary checkout: Delete must destroy the sandbox, never "Remove the project".
import { useEffect } from 'react'
import {
  refreshCloudWorktreeBindings,
  sandboxIdForWorktree,
  useCloudWorkspaceIdentities
} from '@/components/cloud-workspaces/cloud-workspace-identity'
import { getCloudWorkspaceSnapshot, useIsCloudWorkspace } from './orca-cloud-workspace-store'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { isOrcaCloudRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'

type Row = { id: string; hostId?: string | null; isMainWorktree?: boolean }

let primed = false

/** Loads the bindings once per app session (a menu open refreshes them for new pairings). */
export function usePrimeCloudRowBindings(): void {
  useEffect(() => {
    if (!primed) {
      primed = true
      void refreshCloudWorktreeBindings().catch(() => undefined)
    }
  }, [])
}

/** Is the row's host an Orca Cloud server in the runtime catalog (owned, or marked paired)? */
function isCloudHostInCatalog(
  state: Pick<AppState, 'runtimeEnvironments'>,
  hostId: string | null | undefined
): boolean {
  const parsed = parseExecutionHostId(hostId ?? undefined)
  if (parsed?.kind !== 'runtime') {
    return false
  }
  const environment = state.runtimeEnvironments?.find((entry) => entry.id === parsed.environmentId)
  return environment ? isOrcaCloudRuntimeEnvironment(environment) : false
}

/** A row on an Orca Cloud workspace: this desktop's own, or one it paired with. */
export function useIsCloudHostRow(row: Row): boolean {
  const owned = useIsCloudWorkspace(row.id)
  const identities = useCloudWorkspaceIdentities()
  const inCatalog = useAppStore((state) => isCloudHostInCatalog(state, row.hostId))
  return owned || inCatalog || sandboxIdForWorktree(row, identities) !== null
}

/** The cloud workspace itself (the sandbox's own checkout): its Delete destroys the sandbox. */
export function useIsCloudPrimaryRow(row: Row): boolean {
  return useIsCloudHostRow(row) && row.isMainWorktree === true
}

/** A cloud workspace's own row that this desktop did NOT create (paired): no local VM record. */
export function useIsPairedCloudPrimaryRow(row: Row): boolean {
  const owned = useIsCloudWorkspace(row.id)
  return useIsCloudPrimaryRow(row) && !owned
}

/** Non-React: the same, for the delete funnel. */
export function isCloudPrimaryRowNow(row: Row): boolean {
  return (
    row.isMainWorktree === true &&
    (getCloudWorkspaceSnapshot().ids.has(row.id) ||
      isCloudHostInCatalog(useAppStore.getState(), row.hostId) ||
      sandboxIdForWorktree(row) !== null)
  )
}

/** The sandbox behind a cloud row, re-reading the bindings first (a pairing may be new). */
export async function resolveCloudRowSandboxId(row: Row): Promise<string | null> {
  await refreshCloudWorktreeBindings().catch(() => undefined)
  return sandboxIdForWorktree(row)
}
