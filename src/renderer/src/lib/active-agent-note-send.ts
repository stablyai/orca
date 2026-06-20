import type { RuntimeTerminalSend, RuntimeTerminalWait } from '../../../shared/runtime-types'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import {
  findActiveRuntimeTerminal,
  getActiveTerminalNoteTarget,
  type ActiveTerminalNoteTarget
} from './active-agent-note-target'

export {
  getActiveAgentNoteTarget,
  getActiveAgentRuntimeProbeDescriptor,
  getActiveTerminalNoteTarget,
  probeActiveAgentNoteTarget,
  useCanSendNotesToActiveTerminal,
  type ActiveTerminalNoteTarget
} from './active-agent-note-target'

const ACTIVE_AGENT_SEND_TIMEOUT_MS = 8000
const ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS = 15000

export type ActiveAgentNotesSendStatus =
  | 'sent'
  | 'empty'
  | 'no-active-terminal'
  | 'no-agent'
  | 'not-ready'
  | 'not-writable'

export type ActiveAgentNotesSendResult = {
  status: ActiveAgentNotesSendStatus
}

export async function sendNotesToActiveAgentSession({
  worktreeId,
  prompt,
  noteTarget: explicitNoteTarget,
  timeoutMs = ACTIVE_AGENT_SEND_TIMEOUT_MS
}: {
  worktreeId: string
  prompt: string
  noteTarget?: ActiveTerminalNoteTarget
  timeoutMs?: number
}): Promise<ActiveAgentNotesSendResult> {
  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) {
    return { status: 'empty' }
  }

  const state = useAppStore.getState()
  // Why: an explicit target lets the notes dropdown address ANY running agent of
  // the worktree, not just the focused pane; omitted, fall back to the focused
  // active terminal so existing callers keep their behavior. Routing below still
  // resolves the worktree's owner host, so explicit targets stay SSH/remote-correct.
  const noteTarget = explicitNoteTarget ?? getActiveTerminalNoteTarget(state, worktreeId)
  if (!noteTarget) {
    return { status: 'no-active-terminal' }
  }

  // Route by the worktree's owner host so the agent terminal is found and driven
  // on the host that actually runs it, not on the focused runtime.
  const runtimeTarget = getActiveRuntimeTarget(
    getSettingsForWorktreeRuntimeOwner(state, worktreeId)
  )
  const terminal = await findActiveRuntimeTerminal(
    runtimeTarget,
    worktreeId,
    noteTarget,
    ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS
  )
  if (!terminal) {
    return { status: 'no-active-terminal' }
  }

  // Why: sending notes submits with Enter, so only the runtime's agent/idle
  // checks can authorize it; tab labels and renderer state are not enough.
  const agentCheck = await callRuntimeRpc<{ isRunningAgent: boolean }>(
    runtimeTarget,
    'terminal.isRunningAgent',
    { terminal: terminal.handle },
    { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
  )
  if (!agentCheck.isRunningAgent) {
    return { status: 'no-agent' }
  }

  try {
    const { wait } = await callRuntimeRpc<{ wait: RuntimeTerminalWait }>(
      runtimeTarget,
      'terminal.wait',
      { terminal: terminal.handle, for: 'tui-idle', timeoutMs },
      { timeoutMs: timeoutMs + 5000 }
    )
    if (!wait.satisfied) {
      return { status: 'not-ready' }
    }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error)) {
      return { status: 'no-active-terminal' }
    }
    if (isRuntimeTimeout(error)) {
      return { status: 'not-ready' }
    }
    throw error
  }

  const { send } = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
    runtimeTarget,
    'terminal.send',
    {
      terminal: terminal.handle,
      text: trimmedPrompt,
      enter: true,
      client: { id: 'orca-desktop', type: 'desktop' }
    },
    { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
  )
  return send.accepted ? { status: 'sent' } : { status: 'not-writable' }
}

export function activeAgentNotesSendFailureMessage(status: ActiveAgentNotesSendStatus): string {
  switch (status) {
    case 'empty':
      return 'No notes to send.'
    case 'no-active-terminal':
      return 'Open the agent terminal in this worktree, then send the notes again.'
    case 'no-agent':
      return 'The active terminal is not a recognized agent session.'
    case 'not-ready':
      return 'The active agent was not ready for input yet.'
    case 'not-writable':
      return 'The active terminal did not accept the notes.'
    case 'sent':
      return ''
  }
}

function isRuntimeTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('timeout')
}

function isRuntimeTerminalUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('terminal_handle_stale') ||
    message.includes('terminal_exited') ||
    message.includes('terminal_gone') ||
    message.includes('no_active_terminal')
  )
}
