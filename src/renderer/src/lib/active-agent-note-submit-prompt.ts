import type { RuntimeTerminalPromptSubmission } from '../../../shared/runtime-terminal-send-contract'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { ActiveAgentNotesSendResult } from './active-agent-note-send-result'
import { createBrowserUuid } from './browser-uuid'
import {
  ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS,
  isRuntimeTerminalNotWritable,
  isRuntimeTerminalUnavailable
} from './active-agent-terminal-send-readiness'

export async function submitAgentNotePrompt(
  target: Parameters<typeof callRuntimeRpc>[0],
  terminal: string,
  prompt: string
): Promise<ActiveAgentNotesSendResult | null> {
  const requestId = createBrowserUuid()
  let submission: RuntimeTerminalPromptSubmission
  try {
    const result = await callRuntimeRpc<{ submission: RuntimeTerminalPromptSubmission }>(
      target,
      'terminal.submitPrompt',
      {
        terminal,
        requestId,
        prompt,
        client: { id: 'orca-desktop', type: 'desktop' }
      },
      { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
    )
    submission = result.submission
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return null
    }
    if (error instanceof RuntimeRpcCallError && error.code === 'terminal_prompt_queue_full') {
      return { status: 'not-ready', code: 'terminal-send-refused' }
    }
    if (isRuntimeTerminalNotWritable(error) || isRuntimeTerminalUnavailable(error)) {
      return { status: 'not-writable', code: 'terminal_not_writable' }
    }
    // A lost admission reply may still have queued the prompt; never fall back to a second send.
    return { status: 'unconfirmed', code: 'runtime-unverifiable' }
  }

  try {
    while (submission.status === 'pending') {
      const result = await callRuntimeRpc<{ submission: RuntimeTerminalPromptSubmission }>(
        target,
        'terminal.waitPrompt',
        {
          terminal,
          requestId,
          timeoutMs: 10_000
        },
        { timeoutMs: ACTIVE_AGENT_SEND_RPC_TIMEOUT_MS }
      )
      submission = result.submission
    }
  } catch {
    return { status: 'unconfirmed', code: 'runtime-unverifiable' }
  }
  if (submission.status === 'submitted') {
    return submission.send.accepted
      ? { status: 'sent' }
      : { status: 'partial-submit-failed', code: 'submit-send-refused' }
  }
  if (submission.inputWritten) {
    return { status: 'partial-submit-failed', code: 'submit-send-error' }
  }
  switch (submission.reason) {
    case 'permission':
      return { status: 'permission', code: 'terminal-send-permission' }
    case 'no-agent':
      return { status: 'no-agent', code: 'no-agent' }
    case 'not-writable':
      return { status: 'not-writable', code: 'terminal_not_writable' }
    case 'submission-failed':
      return { status: 'status-unavailable', code: 'runtime-unverifiable' }
  }
}
