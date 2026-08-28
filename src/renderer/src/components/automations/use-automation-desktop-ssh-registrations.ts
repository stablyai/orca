import { useAppStore } from '../../store'

/**
 * Desktop SSH *registration* generations, mirrored by the store slice.
 *
 * Only the generation makes an SSH host fenceable, so without it every desktop
 * SSH entry projects as view-only. A target whose generation is unknown is
 * absent from the map rather than defaulted, which degrades that one host to
 * view-only instead of fencing it against a guessed registration.
 *
 * Reads the mirror rather than `ssh.listTargets()`: the store is already fed by
 * every path that changes the target set, so a per-mount IPC round trip bought
 * nothing and went stale the moment a host was added or removed behind it.
 */
export function useAutomationDesktopSshRegistrations(): ReadonlyMap<string, number> {
  return useAppStore((s) => s.sshTargetGenerations)
}
