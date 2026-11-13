// SHARED-MEMBER-SLEEP-HANG: Sleep on a teammate's shared (paired) workspace is the owner's or a team
// admin's. A member sees it disabled with the reason (design: where they look for the control),
// only when both are known: their access to it is not the owner's, and the roster says they are not
// an admin. Unknown either way leaves Sleep enabled; a refusal then says so (paired-sleep-refused).
import { useAppStore } from '@/store'
import { useCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { usePairedCloudAccess } from '@/components/cloud-workspaces/cloud-workspace-identity'
import { useOrgRoster } from '@/components/billing/team/use-org-roster'
import { pairedSleepOwnerOnlyHint } from '@/lib/orca-cloud/paired-sleep-refused-toast'

export function pairedSleepRefusal(
  access: string | null,
  viewerRole: string | null
): 'refused' | null {
  if (access === null || access === 'owner') {
    return null
  }
  if (viewerRole === null || viewerRole === 'owner' || viewerRole === 'admin') {
    return null
  }
  return 'refused'
}

/** The disabled Sleep item's hint for this row, or null when Sleep stays enabled. */
export function usePairedSleepRefusalHint(worktreeId: string): string | null {
  const environmentId = useCloudWorkspace((state) => state.paired[worktreeId] ?? null)
  const access = usePairedCloudAccess(environmentId)
  const orgId = useAppStore((state) => state.orcaProfileAuthStatus?.cloud?.activeOrgId ?? null)
  // Only a paired row known not to be this account's asks for the roster.
  const roster = useOrgRoster(environmentId && access && access !== 'owner' ? orgId : null)
  const viewerRole =
    roster.result?.status === 'ok' ? (roster.result.roster.viewerRole ?? null) : null
  return pairedSleepRefusal(environmentId ? access : null, viewerRole)
    ? pairedSleepOwnerOnlyHint()
    : null
}
