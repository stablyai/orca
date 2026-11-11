// RA-11: Restart on a paired (web-host) pane. The host already runs a terminal in that pane, so a
// desktop reconnect reattaches to it (ensureAgentSession hands back the live session) and nothing
// relaunches. Put exactly that one host terminal to sleep first (the reversible stop the pane-sleep
// path uses: the leaf stays, as a sleeping surface); the reconnect then wakes it with --resume.
// A plain stop is a close: the host drops the tab and there is nothing left to relaunch into.
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { RuntimeTerminalShow } from '../../../../shared/runtime-terminal-contracts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { agentProviderSessionForHostEnsure } from '@/runtime/hosted-terminals/creation/agent-launch/agent-session-ensure-provider-session'
import { toHostSessionTabId } from '../../../../shared/workspace-layout/terminal-surface-id'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'

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
      // Reversible: the host keeps the pane (and its scrollback) for the wake.
      keepHistory: true,
      // Only this pane: every other terminal in the workspace keeps running.
      targetOnly: true
    },
    { timeoutMs: 15_000 }
  )
  if (result.postStopVerified !== true || !result.stoppedPtyIds?.includes(hostPtyId)) {
    throw new Error(result.postStopFailure ?? 'restart_remote_pane_stop_unverified')
  }
}

/**
 * Relaunch the pane's agent on its own conversation, in the same pane. Without this the host wakes
 * the sleeping pane with its original launch (a new conversation). Only for a resumable session;
 * a pane with none takes the host's fresh launch, which is what "Starts a new conversation" says.
 */
export async function resumeRemotePaneAgent(args: {
  ptyId: string
  worktreeId: string
  tabId: string
  leafId: string
  agent: AccountRestartAgent
  providerSession: AgentProviderSessionMetadata
}): Promise<void> {
  const environmentId = parseRemoteRuntimePtyId(args.ptyId)?.environmentId
  if (!environmentId) {
    throw new Error('restart_remote_pane_unowned')
  }
  await callRuntimeRpc(
    { kind: 'environment', environmentId },
    'terminal.ensureAgentSession',
    {
      kind: 'explicit',
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      agent: args.agent,
      providerSession: await agentProviderSessionForHostEnsure(environmentId, args.providerSession),
      // The same pane: the host tab and leaf the stopped terminal lived in.
      placement: { tabId: toHostSessionTabId(args.tabId), leafId: args.leafId },
      presentation: 'background'
    },
    { timeoutMs: 15_000 }
  )
}

/** What Claude prints when `--resume <id>` names a session that never had a conversation. */
const NO_CONVERSATION = /No conversation found with session ID/i
const RESUME_CHECK_MS = 10_000
const RESUME_POLL_MS = 1_000

/**
 * RA-11e backstop: a recorded session can have no conversation on disk (Claude started, never ran a
 * turn). Its `--resume` prints "No conversation found…" and exits, leaving a bare shell. Watch the
 * relaunched pane briefly; if that happened, start the agent fresh in the same shell, once.
 * Returns whether it relaunched fresh.
 */
export async function freshIfResumeFoundNothing(args: {
  /** The pane's PTY id now (the relaunched terminal), or null while it is still binding. */
  currentPtyId: () => string | null
  /** The PTY id the restart replaced; the check waits for a different one. */
  replacedPtyId: string
  freshCommand: string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<boolean> {
  const sleep =
    args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = args.now ?? Date.now
  const deadline = now() + RESUME_CHECK_MS
  while (now() < deadline) {
    await sleep(RESUME_POLL_MS)
    const ptyId = args.currentPtyId()
    const parsed = ptyId && ptyId !== args.replacedPtyId ? parseRemoteRuntimePtyId(ptyId) : null
    if (!parsed?.environmentId) {
      continue
    }
    const target = { kind: 'environment' as const, environmentId: parsed.environmentId }
    const read = await callRuntimeRpc<{ terminal?: { tail?: string[] } }>(
      target,
      'terminal.read',
      { terminal: parsed.handle, limit: 40 },
      { timeoutMs: 5_000 }
    ).catch(() => null)
    if (!read?.terminal?.tail?.some((line) => NO_CONVERSATION.test(line))) {
      continue
    }
    await callRuntimeRpc(
      target,
      'terminal.send',
      { terminal: parsed.handle, text: args.freshCommand, enter: true },
      { timeoutMs: 5_000 }
    )
    return true
  }
  return false
}
