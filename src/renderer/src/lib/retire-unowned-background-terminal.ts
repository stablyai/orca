import { useAppStore } from '@/store'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { isTerminalTabPresent } from '@/store/slices/terminal-tab-retirement'
import { createBrowserUuid } from '@/lib/browser-uuid'
import type { RuntimeCloseIntent } from '../../../shared/runtime-close-intent'

type RetireOwner = { tabId: string } | { worktreeId: string }

// Why: the policy only cross-checks worktreeId for session-tab targets;
// terminal targets match on ptyOrHandle alone, but the schema still requires
// a non-empty worktreeId.
const TERMINAL_ROLLBACK_WORKTREE_PLACEHOLDER = 'terminal-rollback'

// Why: policy hosts refuse reasonless closes from runtime clients, and this
// path only ever retires a terminal this same client just created, so mint the
// creation-rollback intent or the orphaned host PTY leaks.
function mintClientCreatedRollbackIntent(owner: RetireOwner, handle: string): RuntimeCloseIntent {
  return {
    source: 'client-created-rollback',
    userInitiated: false,
    requestId: createBrowserUuid(),
    occurredAt: Date.now(),
    worktreeId: 'worktreeId' in owner ? owner.worktreeId : TERMINAL_ROLLBACK_WORKTREE_PLACEHOLDER,
    ptyOrHandle: handle
  }
}

export async function retireUnownedTerminal(args: {
  /** Present tab id, or `{ worktreeId }` for a launch whose tab is created after the spawn. */
  owner: RetireOwner
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
  /** Present tab id, or `{ worktreeId }`; absent when the worktree id is unknown. */
  owner?: RetireOwner
}): Promise<void> {
  try {
    if (args.runtimeTarget.kind === 'environment' && args.runtimeTerminalHandle) {
      const result = await callRuntimeRpc<{
        close?: { ptyKilled?: boolean; blockedReason?: string }
      }>(args.runtimeTarget, 'terminal.close', {
        terminal: args.runtimeTerminalHandle,
        ...(args.owner
          ? {
              closeIntent: mintClientCreatedRollbackIntent(args.owner, args.runtimeTerminalHandle)
            }
          : {})
      })
      // Why: the close policy soft-denies inside a success envelope; surface it
      // so a denied rollback doesn't read as a silent clean teardown.
      if (result?.close && result.close.ptyKilled !== true) {
        console.warn('[retire-unowned-background-terminal] terminal close not confirmed by host', {
          blockedReason: result.close.blockedReason
        })
      }
    } else if (args.runtimeTarget.kind === 'local') {
      await window.api.pty.kill(args.ptyId)
    }
  } catch {
    // Best-effort provider teardown; the retired tab must not be recreated.
  }
}
