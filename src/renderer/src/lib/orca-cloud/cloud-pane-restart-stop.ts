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
// Claude's own start on a sandbox plus the pane's re-attach can take well over 10 s.
const RESUME_CHECK_MS = 25_000
const RESUME_POLL_MS = 1_000
// eslint-disable-next-line no-control-regex -- terminal output carries ANSI escapes.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

/** The pane's terminal handle on its host, from the pane's PTY id (`remote:<env>@@<handle>`). */
function hostTerminalOf(ptyId: string | null): { environmentId: string; handle: string } | null {
  const parsed = ptyId ? parseRemoteRuntimePtyId(ptyId) : null
  return parsed?.environmentId
    ? { environmentId: parsed.environmentId, handle: parsed.handle }
    : null
}

/**
 * RA-11e backstop: a recorded session can have no conversation on disk (Claude started, never ran a
 * turn). Its `--resume` prints "No conversation found…" and exits, leaving a bare shell. Watch the
 * relaunched pane's terminal (its new handle) for up to 25 s; if that happened, start the agent fresh
 * in the same shell, once. Returns whether it relaunched fresh.
 */
export async function freshIfResumeFoundNothing(args: {
  /** The pane's PTY id now (the relaunched terminal), or null while it is still binding. */
  currentPtyId: () => string | null
  /** The PTY id the restart replaced; only a terminal with a different handle is read. */
  replacedPtyId: string
  freshCommand: string
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<boolean> {
  const sleep =
    args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = args.now ?? Date.now
  const replaced = hostTerminalOf(args.replacedPtyId)
  const deadline = now() + RESUME_CHECK_MS
  let lastSeen: string | null = null
  while (now() < deadline) {
    await sleep(RESUME_POLL_MS)
    const current = hostTerminalOf(args.currentPtyId())
    // Key off the terminal handle, not the whole id: the host may reuse its PTY id on relaunch.
    if (!current || current.handle === replaced?.handle) {
      continue
    }
    if (lastSeen !== current.handle) {
      lastSeen = current.handle
      console.info('[orca-cloud] RA-11e watching relaunched terminal', current.handle)
    }
    const target = { kind: 'environment' as const, environmentId: current.environmentId }
    const read = await callRuntimeRpc<{ terminal?: { tail?: string[] } }>(
      target,
      'terminal.read',
      { terminal: current.handle, limit: 80 },
      { timeoutMs: 5_000 }
    ).catch((err: unknown) => {
      console.warn('[orca-cloud] RA-11e terminal.read failed:', err)
      return null
    })
    const lines = (read?.terminal?.tail ?? []).map((line) => line.replace(ANSI, ''))
    if (!lines.some((line) => NO_CONVERSATION.test(line))) {
      continue
    }
    console.info(
      '[orca-cloud] RA-11e resume found no conversation; starting fresh in',
      current.handle
    )
    await callRuntimeRpc(
      target,
      'terminal.send',
      { terminal: current.handle, text: args.freshCommand, enter: true },
      { timeoutMs: 5_000 }
    )
    return true
  }
  console.info('[orca-cloud] RA-11e watch ended without a "no conversation" line', lastSeen)
  return false
}
