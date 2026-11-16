import { useAppStore } from '@/store'
import type { OrcaProfileAuthStatus } from '../../../shared/orca-profiles/orca-profiles'

/** `${userId}:${activeOrgId}` for the signed-in Orca account, or 'signed-out'. */
export function getOrcaAccountKey(status: OrcaProfileAuthStatus | null | undefined): string {
  const cloud = status?.cloud
  return cloud ? `${cloud.userId}:${cloud.activeOrgId ?? ''}` : 'signed-out'
}

/**
 * `${userId}:${activeOrgId}` for the signed-in Orca account. Team-scoped views key on it so a
 * team switch remounts them: nothing read for the previous team survives into the new one.
 */
export function useOrcaAccountKey(): string {
  return useAppStore((state) => getOrcaAccountKey(state.orcaProfileAuthStatus))
}
