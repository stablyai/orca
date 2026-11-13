// Who the control plane answers for: the Orca account and its active team. Answers cached per
// repository (GitHub access, the team's GitHub repositories) belong to one identity; after a
// sign-out or a team switch they must not keep showing as the new identity's state (np4-e2e).
import { useAppStore } from '@/store'
import type { OrcaProfileAuthStatus } from '../../../../shared/orca-profiles'

/** '' while signed out or not connected; otherwise stable for one account, team and role. */
export function orcaCloudIdentityKey(status: OrcaProfileAuthStatus | null | undefined): string {
  if (status?.state !== 'connected' || !status.cloud) {
    return ''
  }
  const orgId = status.cloud.activeOrgId ?? ''
  // The role too (GH-LIST-MISSING): an owner → member → owner switch must read team answers again.
  const role = status.organizations?.find((org) => org.orgId === orgId)?.role ?? ''
  return `${status.activeProfileId}\0${status.cloud.userId}\0${orgId}\0${role}`
}

export function useOrcaCloudIdentityKey(): string {
  return useAppStore((s) => orcaCloudIdentityKey(s.orcaProfileAuthStatus))
}
