import type { RuntimeTerminalSend } from '../../../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { ActiveAgentNotesSendResult } from './active-agent-note-send-result'
import {
  ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS,
  isRuntimeTerminalNotWritable,
  isRuntimeTerminalUnavailable
} from './active-agent-terminal-send-readiness'
import { runtimeFailureCode } from './active-agent-note-send-diagnostics'
import { ORCA_DESKTOP_TERMINAL_CLIENT, runSendInLane } from './active-agent-note-send-delivery'

/** Paste and Enter in one send, for hosts that cannot guard them separately. */
export function sendPromptWithLegacyCombinedSend(
  runtimeTarget: Parameters<typeof callRuntimeRpc>[0],
  terminalHandle: string,
  prompt: string,
  submit = true
): Promise<ActiveAgentNotesSendResult> {
  return runSendInLane(runtimeTarget, terminalHandle, () =>
    sendLegacyCombined(runtimeTarget, terminalHandle, prompt, submit)
  )
}

async function sendLegacyCombined(
  runtimeTarget: Parameters<typeof callRuntimeRpc>[0],
  terminalHandle: string,
  prompt: string,
  submit: boolean
): Promise<ActiveAgentNotesSendResult> {
  try {
    const { send } = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      runtimeTarget,
      'terminal.send',
      {
        terminal: terminalHandle,
        text: prompt,
        enter: submit,
        client: ORCA_DESKTOP_TERMINAL_CLIENT
      },
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
