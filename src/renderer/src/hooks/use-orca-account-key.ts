import { useAppStore } from '@/store'

/**
 * `${userId}:${activeOrgId}` for the signed-in Orca account. Team-scoped views key on it so a
 * team switch remounts them: nothing read for the previous team survives into the new one.
 */
export function useOrcaAccountKey(): string {
  return useAppStore((state) => {
    const cloud = state.orcaProfileAuthStatus?.cloud
    return cloud ? `${cloud.userId}:${cloud.activeOrgId ?? ''}` : 'signed-out'
  })
}
