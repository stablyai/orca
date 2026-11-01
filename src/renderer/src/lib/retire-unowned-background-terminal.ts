import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { isTerminalTabPresent } from '@/store/slices/terminal-tab-retirement'
import type { ExecutionHostId } from '../../../shared/execution-host'

export async function retireUnownedTerminal(args: {
  /** Present tab id, or `{ worktreeId }` for a launch whose tab is created after the spawn. */
  owner: { tabId: string } | { worktreeId: string; hostId?: ExecutionHostId }
  ptyId: string
  runtimeTarget: RuntimeClientTarget
  runtimeTerminalHandle?: string | null
  onRetire?: () => void
}): Promise<boolean> {
  const state = useAppStore.getState()
  const owner = args.owner
  const isOwned =
    'tabId' in owner
      ? isTerminalTabPresent(state, owner.tabId)
      : // Folder workspaces exist only in getKnownWorktreeById.
        state.getKnownWorktreeById(owner.worktreeId, owner.hostId) !== undefined
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
}): Promise<void> {
  try {
    if (args.runtimeTarget.kind === 'environment' && args.runtimeTerminalHandle) {
      await callRuntimeRpc(args.runtimeTarget, 'terminal.close', {
        terminal: args.runtimeTerminalHandle
      })
    } else if (args.runtimeTarget.kind === 'local') {
      await window.api.pty.kill(args.ptyId)
    }
  } catch {
    // Best-effort provider teardown; the retired tab must not be recreated.
  }
}
