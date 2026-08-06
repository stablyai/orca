import { useAppStore } from '@/store'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { isTerminalTabPresent } from '@/store/slices/terminal-tab-retirement'

export function adoptSpawn(result: { id: string; spawnRetirementToken?: string }): void {
  if (result.spawnRetirementToken) {
    window.api.pty.adoptSpawnReservation(result.id, result.spawnRetirementToken)
  }
}

export async function retireUnownedTerminal(args: {
  /** Present tab id, or `{ worktreeId }` for a launch whose tab is created after the spawn. */
  owner: { tabId: string } | { worktreeId: string }
  ptyId: string
  runtimeTarget: RuntimeClientTarget
  runtimeTerminalHandle?: string | null
  spawnRetirementToken?: string
  onRetire?: () => void
}): Promise<boolean> {
  const state = useAppStore.getState()
  const owner = args.owner
  const isOwned =
    'tabId' in owner
      ? isTerminalTabPresent(state, owner.tabId)
      : // Folder workspaces exist only in getKnownWorktreeById.
        state.getKnownWorktreeById(owner.worktreeId) !== undefined
  if (isOwned) {
    return false
  }
  // Close can win before the provider is bindable to store state.
  args.onRetire?.()
  await retireProvider(args)
  return true
}

export async function retireProvider(args: {
  ptyId: string
  runtimeTarget: RuntimeClientTarget
  runtimeTerminalHandle?: string | null
  spawnRetirementToken?: string
}): Promise<void> {
  if (!args.ptyId) {
    return
  }
  try {
    if (args.runtimeTarget.kind === 'environment' && args.runtimeTerminalHandle) {
      await callRuntimeRpc(args.runtimeTarget, 'terminal.close', {
        terminal: args.runtimeTerminalHandle
      })
    } else if (args.runtimeTarget.kind === 'local') {
      const shouldKill = args.spawnRetirementToken
        ? window.api.pty.releaseSpawnReservation(args.ptyId, args.spawnRetirementToken)
        : true
      if (shouldKill) {
        await window.api.pty.kill(args.ptyId)
      }
    }
  } catch {
    // Best-effort provider teardown; the retired tab must not be recreated.
  }
}
