import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { isTerminalInputTooLargeWithDeferredMeasurement } from '../../../shared/terminal-input'
import { readTerminalSendAcknowledgment } from '../../../shared/terminal-send-acknowledgment'
import { classifyTerminalProcessInspectionFailure } from '../../../shared/terminal-process-inspection'
import { callRuntimeRpc } from './runtime-rpc-client'
import { getRemoteRuntimePtyOwner } from './runtime-terminal-stream'
import { recordRuntimeTerminalInputForPtyId } from './runtime-terminal-input-recording'

const DESKTOP_RUNTIME_CLIENT = { id: 'orca-desktop', type: 'desktop' } as const

/**
 * True means accepted, false means refusal. `requireWriteSettlement` asks the local provider or a
 * current host for its acknowledgment; a lost one rejects.
 */
export async function sendRuntimePtyInputVerified(
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  options?: { requireWriteSettlement?: true }
): Promise<boolean> {
  const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
  if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
    return false
  }
  const owner = getRemoteRuntimePtyOwner(ptyId)
  if (!owner) {
    if (options?.requireWriteSettlement) {
      // Why: an answer that dismisses its card must not fall back to an unacknowledged write.
      const accepted = await window.api.pty.writeAccepted(ptyId, data, inputKind, options)
      if (accepted) {
        recordRuntimeTerminalInputForPtyId(ptyId)
      }
      return accepted
    }
    const accepted = await window.api.pty.writeAccepted(ptyId, data, inputKind)
    if (!accepted) {
      window.api.pty.write(ptyId, data, inputKind)
      // Why: SSH/local fallback writes are fire-and-forget. Callers use this
      // boolean to continue UX flow, while hook telemetry confirms real turns.
      recordRuntimeTerminalInputForPtyId(ptyId)
      return true
    }
    recordRuntimeTerminalInputForPtyId(ptyId)
    return accepted
  }

  const { target, terminal } = owner
  try {
    const result = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      target,
      'terminal.send',
      {
        terminal,
        text: data,
        client: DESKTOP_RUNTIME_CLIENT,
        ...(options?.requireWriteSettlement ? { requireWriteSettlement: true } : {})
      },
      { timeoutMs: 15_000 }
    )
    if (result.send.accepted === true) {
      recordRuntimeTerminalInputForPtyId(ptyId)
    }
    const acknowledgment = readTerminalSendAcknowledgment(result)
    if (acknowledgment === 'unverifiable') {
      throw new Error('PTY write acknowledgment unavailable')
    }
    return acknowledgment === 'accepted'
  } catch (error) {
    if (classifyTerminalProcessInspectionFailure(error) === 'terminal_gone') {
      return false
    }
    throw error
  }
}
