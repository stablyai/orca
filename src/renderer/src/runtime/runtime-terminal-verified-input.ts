import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import type { TerminalInputKind } from '../../../shared/terminal/input/terminal-input-kind'
import { isTerminalInputTooLargeWithDeferredMeasurement } from '../../../shared/terminal/input/terminal-input'
import { readTerminalSendAcknowledgment } from '../../../shared/terminal/pty/lifecycle/terminal-send-acknowledgment'
import { classifyTerminalProcessInspectionFailure } from '../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { callRuntimeRpc } from './runtime-rpc-client'
import { getRemoteRuntimePtyOwner } from './runtime-terminal-stream'
import { recordRuntimeTerminalInputForPtyId } from './runtime-terminal-input-recording'
import type { GeneratedInputAttempt } from './generated-input-attempt'

const DESKTOP_RUNTIME_CLIENT = { id: 'orca-desktop', type: 'desktop' } as const

/**
 * True means accepted, false means refusal. `requireWriteSettlement` asks the local provider or a
 * current host for its acknowledgment; a lost one rejects.
 */
export async function sendRuntimePtyInputVerified(
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  /** `generatedInputOperationId`: the window's accepted generated request these bytes carry, so
   *  the runtime that writes them settles it even when this window is gone. */
  options?: {
    requireWriteSettlement?: true
    generatedInputOperationId?: string
    /** A generated request's own end and the route it already selected for that host. */
    attempt?: GeneratedInputAttempt
    /** That request's caller cancellation; it rides the existing cancellable route. */
    signal?: AbortSignal
    /** Synchronously, as these bytes are actually handed to IPC; a throw sends nothing. */
    beforeSend?: () => void
  }
): Promise<boolean> {
  const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
  if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
    return false
  }
  const owner = getRemoteRuntimePtyOwner(ptyId)
  const generated = options?.generatedInputOperationId
    ? { generatedInputOperationId: options.generatedInputOperationId }
    : undefined
  if (!owner) {
    options?.beforeSend?.()
    if (options?.requireWriteSettlement) {
      // Why: an answer that dismisses its card must not fall back to an unacknowledged write.
      const accepted = await window.api.pty.writeAccepted(ptyId, data, inputKind, {
        requireWriteSettlement: true,
        ...generated
      })
      if (accepted) {
        recordRuntimeTerminalInputForPtyId(ptyId)
      }
      return accepted
    }
    const accepted = await window.api.pty.writeAccepted(ptyId, data, inputKind, generated)
    if (!accepted) {
      window.api.pty.write(ptyId, data, inputKind, generated)
      // SSH/local fallback writes are fire-and-forget; boolean advances UX while hook telemetry proves actual turns.
      recordRuntimeTerminalInputForPtyId(ptyId)
      return true
    }
    recordRuntimeTerminalInputForPtyId(ptyId)
    return accepted
  }

  const { target, terminal } = owner
  const attempt = options?.attempt
  // The status this request already selected for this host; it is never read again for it.
  const selection =
    attempt?.selection?.environmentId === target.environmentId ? attempt.selection : undefined
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
      {
        timeoutMs: 15_000,
        ...generated,
        ...(selection
          ? {
              skipCompatibilityCheck: true,
              expectedEnvironmentPairingRevision: selection.pairingRevision
            }
          : {}),
        ...(attempt?.end != null ? { generatedInputEnd: attempt.end } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.beforeSend ? { beforeSend: options.beforeSend } : {})
      }
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
