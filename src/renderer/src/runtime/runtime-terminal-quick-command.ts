import type { RuntimeTerminalResolvePane, RuntimeTerminalSend } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'

// The settled agent contract may spend up to 13s on render and submission markers before network overhead.
const QUICK_COMMAND_SEND_TIMEOUT_MS = 30_000
const DESKTOP_RUNTIME_CLIENT = { id: 'orca-desktop', type: 'desktop' } as const

export async function sendRuntimeTerminalQuickCommand({
  worktreeId,
  tabId,
  leafId,
  expectedPtyId,
  text,
  isCurrent
}: {
  worktreeId: string
  tabId: string
  leafId: string
  expectedPtyId: string
  text: string
  isCurrent?: () => boolean
}): Promise<boolean> {
  // Keep the PTY transport module out of the store's slice-construction cycle.
  const [{ useAppStore }, { getSettingsForWorktreeRuntimeOwner }] = await Promise.all([
    import('@/store'),
    import('@/lib/worktree-runtime-owner')
  ])
  const state = useAppStore.getState()
  const target = getActiveRuntimeTarget(getSettingsForWorktreeRuntimeOwner(state, worktreeId))
  try {
    const { terminal } = await callRuntimeRpc<{ terminal: RuntimeTerminalResolvePane }>(
      target,
      'terminal.resolvePane',
      { paneKey: makePaneKey(tabId, leafId), worktreeId },
      { timeoutMs: QUICK_COMMAND_SEND_TIMEOUT_MS }
    )
    if (
      terminal.tabId !== tabId ||
      terminal.leafId !== leafId ||
      terminal.ptyId !== expectedPtyId ||
      (terminal.worktreeId !== undefined && terminal.worktreeId !== worktreeId)
    ) {
      return false
    }
    if (isCurrent && !isCurrent()) {
      return false
    }
    const { send } = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      target,
      'terminal.send',
      {
        terminal: terminal.handle,
        text,
        quickCommand: true,
        client: DESKTOP_RUNTIME_CLIENT
      },
      { timeoutMs: QUICK_COMMAND_SEND_TIMEOUT_MS }
    )
    if (isCurrent && !isCurrent()) {
      return false
    }
    return send.accepted === true
  } catch {
    return false
  }
}
