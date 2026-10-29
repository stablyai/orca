import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import { sanitizeTerminalPasteText } from '@/components/terminal-pane/terminal-bracketed-paste'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  BRACKETED_PASTE_BEGIN,
  BRACKETED_PASTE_END,
  POST_PASTE_SUBMIT_DELAY_MS
} from './agent-paste-draft'
import type { ActiveAgentNotesSendResult } from './active-agent-note-send-result'
import {
  ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS,
  getTerminalAgentSendReadiness,
  isRuntimeTerminalNotWritable,
  isRuntimeTerminalUnavailable
} from './active-agent-terminal-send-readiness'
import { codeForReadinessStatus, runtimeFailureCode } from './active-agent-note-send-diagnostics'

const ORCA_DESKTOP_TERMINAL_CLIENT = { id: 'orca-desktop', type: 'desktop' as const }

export async function sendPromptWithLegacyCombinedSend(
  runtimeTarget: Parameters<typeof callRuntimeRpc>[0],
  terminalHandle: string,
  prompt: string
): Promise<ActiveAgentNotesSendResult> {
  try {
    const { send } = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      runtimeTarget,
      'terminal.send',
      { terminal: terminalHandle, text: prompt, enter: true, client: ORCA_DESKTOP_TERMINAL_CLIENT },
      { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
    )
    return send.accepted
      ? { status: 'sent' }
      : { status: 'not-writable', code: 'terminal-send-refused' }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error)) {
      return {
        status: 'no-active-terminal',
        code: runtimeFailureCode(error) ?? 'runtime-unverifiable'
      }
    }
    if (isRuntimeTerminalNotWritable(error)) {
      return { status: 'not-writable', code: 'terminal_not_writable' }
    }
    throw error
  }
}

export async function sendPromptWithGuardedPasteAndEnter(
  runtimeTarget: Parameters<typeof callRuntimeRpc>[0],
  terminalHandle: string,
  prompt: string,
  options: { allowLegacyFallback: boolean }
): Promise<ActiveAgentNotesSendResult> {
  const initialAgentStatus = await getTerminalAgentSendReadiness(
    runtimeTarget,
    terminalHandle,
    options
  )
  if (
    initialAgentStatus.status !== 'sendable' &&
    !(initialAgentStatus.status === 'no-agent' && initialAgentStatus.supportsGuardedSend)
  ) {
    return {
      status: initialAgentStatus.status,
      code: initialAgentStatus.code ?? codeForReadinessStatus(initialAgentStatus.status)
    }
  }

  const pastePayload = `${BRACKETED_PASTE_BEGIN}${sanitizeTerminalPasteText(prompt)}${BRACKETED_PASTE_END}`
  try {
    const { send } = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      runtimeTarget,
      'terminal.send',
      {
        terminal: terminalHandle,
        text: pastePayload,
        requireAgentStatus: 'sendable',
        client: ORCA_DESKTOP_TERMINAL_CLIENT
      },
      { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
    )
    if (!send.accepted) {
      if (send.refusedReason === 'permission') {
        return { status: 'permission', code: 'terminal-send-permission' }
      }
      if (send.refusedReason === 'no-agent') {
        return { status: 'no-agent', code: 'no-agent' }
      }
      return { status: 'not-writable', code: 'terminal-send-refused' }
    }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error)) {
      return {
        status: 'no-active-terminal',
        code: runtimeFailureCode(error) ?? 'runtime-unverifiable'
      }
    }
    if (isRuntimeTerminalNotWritable(error)) {
      return { status: 'not-writable', code: 'terminal_not_writable' }
    }
    throw error
  }

  await new Promise<void>((resolve) => setTimeout(resolve, POST_PASTE_SUBMIT_DELAY_MS))
  try {
    const submitAgentStatus = await getTerminalAgentSendReadiness(
      runtimeTarget,
      terminalHandle,
      options
    )
    if (
      submitAgentStatus.status !== 'sendable' &&
      !(submitAgentStatus.status === 'no-agent' && submitAgentStatus.supportsGuardedSend)
    ) {
      return {
        status: 'partial-submit-failed',
        code: submitAgentStatus.code ?? 'submit-readiness-lost'
      }
    }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error)) {
      return {
        status: 'partial-submit-failed',
        code: runtimeFailureCode(error) ?? 'submit-terminal-unavailable'
      }
    }
    throw error
  }

  try {
    const { send } = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      runtimeTarget,
      'terminal.send',
      {
        terminal: terminalHandle,
        enter: true,
        requireAgentStatus: 'sendable',
        client: ORCA_DESKTOP_TERMINAL_CLIENT
      },
      { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
    )
    return send.accepted
      ? { status: 'sent' }
      : { status: 'partial-submit-failed', code: 'submit-send-refused' }
  } catch (error) {
    if (isRuntimeTerminalUnavailable(error) || isRuntimeTerminalNotWritable(error)) {
      return { status: 'partial-submit-failed', code: 'submit-send-error' }
    }
    throw error
  }
}
