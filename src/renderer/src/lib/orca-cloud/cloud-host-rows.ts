// Which sidebar rows are Orca Cloud workspaces, including PAIRED ones (CLOUD-PRIMARY-DELETE).
// `useIsCloudWorkspace` knows only the workspaces this desktop created. A workspace opened from Home
// on another desktop (or after a re-sign-in) is paired: a "<name> (cloud)" server whose rows live on
// `runtime:<environmentId>`. The cloud identity store already maps both kinds to their sandbox
// (this desktop's runtime records, and the pairing bindings), so this reads it.
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

/** A row on an Orca Cloud workspace: this desktop's own, or one it paired with. */
export function useIsCloudHostRow(row: Row): boolean {
  const owned = useIsCloudWorkspace(row.id)
  const identities = useCloudWorkspaceIdentities()
  return owned || sandboxIdForWorktree(row, identities) !== null
}

/** The cloud workspace itself (the sandbox's own checkout): its Delete destroys the sandbox. */
export function useIsCloudPrimaryRow(row: Row): boolean {
  return useIsCloudHostRow(row) && row.isMainWorktree === true
}

/** Non-React: the same, for the delete funnel. */
export function isCloudPrimaryRowNow(row: Row): boolean {
  return (
    row.isMainWorktree === true &&
    (getCloudWorkspaceSnapshot().ids.has(row.id) || sandboxIdForWorktree(row) !== null)
  )
}

/** The sandbox behind a cloud row, re-reading the bindings first (a pairing may be new). */
export async function resolveCloudRowSandboxId(row: Row): Promise<string | null> {
  await refreshCloudWorktreeBindings().catch(() => undefined)
  return sandboxIdForWorktree(row)
}
