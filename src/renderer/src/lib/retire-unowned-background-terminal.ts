import { useAppStore } from '@/store'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { isTerminalTabPresent } from '@/store/slices/terminal-tab-retirement'

export async function retireUnownedTerminal(args: {
  tabId: string
  ptyId: string
  runtimeTarget: RuntimeClientTarget
  runtimeTerminalHandle?: string | null
  onRetire?: () => void
}): Promise<boolean> {
  if (isTerminalTabPresent(useAppStore.getState(), args.tabId)) {
    return false
  }
  // Why: close can win while provider creation is in flight, before the
  // returned handle is bindable to store state or visible to tab retirement.
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
