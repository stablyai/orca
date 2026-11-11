// RA-11: Restart on a paired (web-host) pane. The host already runs a terminal in that pane, so a
// desktop reconnect reattaches to it (ensureAgentSession hands back the live session) and nothing
// relaunches. Stop exactly that one host terminal first; the reconnect then starts the agent anew.
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { RuntimeTerminalShow } from '../../../../shared/runtime-terminal-contracts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'

type StopExactResult = {
  stoppedPtyIds?: string[]
  postStopVerified?: boolean
  postStopFailure?: string
}

/** Stop the host terminal behind one remote pane. Throws unless the host confirms it stopped. */
export async function stopRemotePaneTerminalForRestart(
  ptyId: string,
  worktreeId: string
): Promise<void> {
  const parsed = parseRemoteRuntimePtyId(ptyId)
  if (!parsed?.environmentId) {
    throw new Error('restart_remote_pane_unowned')
  }
  const target = { kind: 'environment' as const, environmentId: parsed.environmentId }
  // The pane names its terminal by handle; the host stops by its own PTY id.
  const { terminal } = await callRuntimeRpc<{ terminal?: RuntimeTerminalShow }>(
    target,
    'terminal.show',
    { terminal: parsed.handle },
    { timeoutMs: 10_000 }
  )
  const hostPtyId = terminal?.ptyId
  if (!hostPtyId) {
    throw new Error('restart_remote_pane_not_live')
  }
  const result = await callRuntimeRpc<StopExactResult>(
    target,
    'terminal.stopExact',
    {
      worktree: toRuntimeWorktreeSelector(worktreeId),
      expectedPtyIds: [hostPtyId],
      // Only this pane: every other terminal in the workspace keeps running.
      targetOnly: true
    },
    { timeoutMs: 15_000 }
  )
  if (result.postStopVerified !== true || !result.stoppedPtyIds?.includes(hostPtyId)) {
    throw new Error(result.postStopFailure ?? 'restart_remote_pane_stop_unverified')
  }
}
