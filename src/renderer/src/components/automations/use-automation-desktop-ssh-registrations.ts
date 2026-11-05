import { useAppStore } from '../../store'

/** Use the live store’s registration generations instead of per-mount listTargets IPC. Omit unknown generations so only that host stays view-only; never guess a fence. */
export function useAutomationDesktopSshRegistrations(): ReadonlyMap<string, number> {
  return useAppStore((s) => s.sshTargetGenerations)
}
