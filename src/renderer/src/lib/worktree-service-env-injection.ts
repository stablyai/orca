import { useAppStore } from '@/store'

export function getWorktreeServiceEnv(worktreeId: string | undefined): Record<string, string> {
  if (!worktreeId) {
    return {}
  }
  return useAppStore.getState().worktreeServicesEnv?.[worktreeId] ?? {}
}
