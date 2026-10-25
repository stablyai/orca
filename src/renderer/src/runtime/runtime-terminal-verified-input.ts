import type { ChatStopInput } from '../../../shared/chat-stop-input'
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
 * Ordinary true is the legacy delivery result. Only `requireWriteSettlement` asks the local
 * provider or a current host for acknowledgment; a lost one rejects.
 */
export async function sendRuntimePtyInputVerified(
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  options?: { requireWriteSettlement?: true; chatStop?: ChatStopInput }
): Promise<boolean> {
  const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
  if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
    return false
  }
  const owner = getRemoteRuntimePtyOwner(ptyId)
  if (!owner) {
    if (options?.requireWriteSettlement || options?.chatStop) {
      // Answers need proof; explicit Stop must never resend after its first handoff.
      const accepted = await window.api.pty.writeAccepted(ptyId, data, inputKind, options)
      if (accepted) {
        recordRuntimeTerminalInputForPtyId(ptyId)
      }
      return accepted
    }
    const accepted = await window.api.pty.writeAccepted(ptyId, data, inputKind)
    if (!accepted) {
      window.api.pty.write(ptyId, data, inputKind)
      // SSH/local fallback writes are fire-and-forget; boolean advances UX while hook telemetry proves actual turns.
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
        ...(options?.requireWriteSettlement ? { requireWriteSettlement: true } : {}),
        ...(options?.chatStop ? { chatStop: options.chatStop } : {})
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
