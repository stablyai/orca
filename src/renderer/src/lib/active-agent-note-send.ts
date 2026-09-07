import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { findActiveRuntimeTerminal, getActiveTerminalNoteTarget } from './active-agent-note-target'
import type { ActiveTerminalNoteTarget } from './active-agent-note-target'
import type { ActiveAgentNotesSendResult } from './active-agent-note-send-result'
import {
  ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS,
  getTerminalAgentSendReadiness,
  isRuntimeTerminalUnavailable,
  isRuntimeTimeout
} from './active-agent-terminal-send-readiness'
import {
  codeForReadinessStatus,
  reportNoteSendFailure,
  runtimeFailureCode,
  runtimeFailureFallbackCode
} from './active-agent-note-send-diagnostics'
import {
  sendPromptWithGuardedPasteAndEnter,
  sendPromptWithLegacyCombinedSend
} from './active-agent-note-send-delivery'

export {
  getActiveAgentNoteTarget,
  getActiveAgentRuntimeProbeDescriptor,
  getActiveTerminalNoteTarget,
  probeActiveAgentNoteTarget,
  type ActiveTerminalNoteTarget
} from './active-agent-note-target'
export {
  activeAgentNotesSendFailureMessage,
  type ActiveAgentNotesSendResult,
  type ActiveAgentNotesSendStatus
} from './active-agent-note-send-result'
const ACTIVE_AGENT_SEND_TIMEOUT_MS = 8000

export async function sendNotesToActiveAgentSession(args: {
  worktreeId: string
  prompt: string
  noteTarget?: ActiveTerminalNoteTarget
  timeoutMs?: number
}): Promise<ActiveAgentNotesSendResult> {
  try {
    return await sendNotesToActiveAgentSessionInternal(args)
  } catch (error) {
    return reportNoteSendFailure(
      { status: 'status-unavailable', code: runtimeFailureFallbackCode(error) },
      args.noteTarget ?? null
    )
  }
}
async function sendNotesToActiveAgentSessionInternal({
  worktreeId,
  prompt,
  noteTarget: explicitNoteTarget,
  timeoutMs
}: {
  worktreeId: string
  prompt: string
  noteTarget?: ActiveTerminalNoteTarget
  timeoutMs?: number
}): Promise<ActiveAgentNotesSendResult> {
  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) {
    return { status: 'empty', code: 'empty' }
  }
  const state = useAppStore.getState()
  const noteTarget = explicitNoteTarget ?? getActiveTerminalNoteTarget(state, worktreeId)
  if (!noteTarget) {
    return reportNoteSendFailure({ status: 'no-active-terminal', code: 'no-note-target' }, null)
  }
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
    return reportNoteSendFailure(
      { status: 'no-active-terminal', code: 'no-inventory-match' },
      noteTarget
    )
  }
  if (explicitNoteTarget) {
    return reportNoteSendFailure(
      await sendPromptToExplicitAgentTarget(runtimeTarget, terminal.handle, trimmedPrompt),
      noteTarget
    )
  }
  const effectiveTimeoutMs = timeoutMs ?? ACTIVE_AGENT_SEND_TIMEOUT_MS
  const initialAgentStatus = await getTerminalAgentSendReadiness(runtimeTarget, terminal.handle, {
    allowLegacyFallback: true
  })
  if (initialAgentStatus.status !== 'sendable') {
    return reportNoteSendFailure(
      {
        status: initialAgentStatus.status,
        code: initialAgentStatus.code ?? codeForReadinessStatus(initialAgentStatus.status)
      },
      noteTarget
    )
  }
  try {
    const { wait } = await callRuntimeRpc<{ wait: RuntimeTerminalWait }>(
      runtimeTarget,
      'terminal.wait',
      { terminal: terminal.handle, for: 'tui-idle', timeoutMs: effectiveTimeoutMs },
      { timeoutMs: effectiveTimeoutMs + 5000 }
    )
    if (wait.status !== 'running') {
      return reportNoteSendFailure(
        { status: 'no-active-terminal', code: 'terminal_wait_not_running' },
        noteTarget
      )
    }
    if (wait.blockedReason) {
      return reportNoteSendFailure(
        { status: 'permission', code: 'terminal_wait_blocked' },
        noteTarget
      )
    }
    if (!wait.satisfied) {
      return reportNoteSendFailure(
        { status: 'not-ready', code: 'terminal_wait_unsatisfied' },
        noteTarget
      )
    }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error)) {
      return reportNoteSendFailure(
        { status: 'no-active-terminal', code: runtimeFailureCode(error) ?? 'runtime-unverifiable' },
        noteTarget
      )
    }
    if (isRuntimeTimeout(error)) {
      return reportNoteSendFailure(
        { status: 'not-ready', code: 'terminal_wait_timeout' },
        noteTarget
      )
    }
    throw error
  }
  const finalAgentStatus = await getTerminalAgentSendReadiness(runtimeTarget, terminal.handle, {
    allowLegacyFallback: true
  })
  if (finalAgentStatus.status !== 'sendable') {
    return reportNoteSendFailure(
      {
        status: finalAgentStatus.status,
        code: finalAgentStatus.code ?? codeForReadinessStatus(finalAgentStatus.status)
      },
      noteTarget
    )
  }

  if (finalAgentStatus.supportsGuardedSend) {
    return reportNoteSendFailure(
      await sendPromptWithGuardedPasteAndEnter(runtimeTarget, terminal.handle, trimmedPrompt, {
        allowLegacyFallback: false
      }),
      noteTarget
    )
  }

  return reportNoteSendFailure(
    await sendPromptWithLegacyCombinedSend(runtimeTarget, terminal.handle, trimmedPrompt),
    noteTarget
  )
}

async function sendPromptToExplicitAgentTarget(
  runtimeTarget: ReturnType<typeof getActiveRuntimeTarget>,
  terminalHandle: string,
  prompt: string
): Promise<ActiveAgentNotesSendResult> {
  return await sendPromptWithGuardedPasteAndEnter(runtimeTarget, terminalHandle, prompt, {
    allowLegacyFallback: false
  })
}
