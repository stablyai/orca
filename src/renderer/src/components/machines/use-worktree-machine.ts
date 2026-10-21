import { useAppStore } from '@/store'
import { useMachineForHost } from '@/store/machines'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { machineHostKeyForWorktree, type MachineMatch } from '@/lib/machines/machine-host-match'
import { machineNeedsWake } from '@/lib/machines/machine-display-state'
import { isMachineConnectionError } from '@/lib/machines/machine-copy'

export function isStoppedMachine(match: MachineMatch): boolean {
  return machineNeedsWake(match.machine.state) || match.machine.state === 'gone'
}

/** The host's machine when it sleeps, is archived or is gone, so nothing there can connect. */
export function useStoppedMachineForHost(hostKey: string | null | undefined): MachineMatch | null {
  const machine = useMachineForHost(hostKey)
  return machine && isStoppedMachine(machine) ? machine : null
}

/** The machine a worktree runs on, in any state; null for every other worktree. */
export function useWorktreeMachine(worktreeId: string | null): MachineMatch | null {
  const hostKey = useAppStore((state) => {
    const worktree = worktreeId ? findWorktreeById(state.worktreesByRepo, worktreeId) : null
    const repo = worktree
      ? state.repos.find((candidate) => candidate.id === worktree.repoId)
      : undefined
    return worktree ? machineHostKeyForWorktree(worktree, repo) : null
  })
  return useMachineForHost(hostKey)
}

/** The worktree's machine when it sleeps, is archived or is gone. */
export function useWorktreeStoppedMachine(worktreeId: string | null): MachineMatch | null {
  const machine = useWorktreeMachine(worktreeId)
  return machine && isStoppedMachine(machine) ? machine : null
}

/**
 * What a terminal's error means on a machine: stopped (say why, offer Wake) or a running machine's
 * server the transport couldn't reach. Null when the raw error should show as usual.
 */
export function useTerminalMachineBanner(
  worktreeId: string,
  terminalError: string | null
): { match: MachineMatch; worktreeId: string; unreachable: boolean } | null {
  const machine = useWorktreeMachine(worktreeId)
  if (!machine || !terminalError) {
    return null
  }
  if (isStoppedMachine(machine)) {
    return { match: machine, worktreeId, unreachable: false }
  }
  return isMachineConnectionError(terminalError)
    ? { match: machine, worktreeId, unreachable: true }
    : null
}
