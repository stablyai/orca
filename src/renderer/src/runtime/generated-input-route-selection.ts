import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { GeneratedInputLifetime } from '../../../shared/generated-input-lifetime'
import { selectRuntimeEnvironmentStatus } from './runtime-rpc-client'
import { clearRuntimeCompatibilityEntry } from './runtime-compatibility-cache'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import {
  generatedInputAttemptExpired,
  type GeneratedInputAttempt,
  type GeneratedInputSelection
} from './generated-input-attempt'

/** The status a generated request's paired-host route is chosen by, selected once per attempt:
 *  a later send of the same attempt (an older host's frames, a caller's fallback) reuses it.
 *  This request stops waiting at its own end or its caller's cancellation, without ending a status
 *  read other readers share. Not sent when it could not be selected in time. */
export async function selectGeneratedInputRoute(
  attempt: GeneratedInputAttempt,
  environmentId: string,
  request: { operationId?: string; submit: boolean },
  signal?: AbortSignal
): Promise<GeneratedInputSelection | 'not-sent'> {
  if (attempt.selection?.environmentId === environmentId) {
    return attempt.selection
  }
  if (generatedInputAttemptExpired(attempt) || signal?.aborted) {
    return 'not-sent'
  }
  // Fixed before anything is awaited: a later re-pair cannot move this request.
  let pairingRevision = captureRuntimeEnvironmentRequestRevision(environmentId) ?? null
  const waiting = new GeneratedInputLifetime({
    deadline: attempt.end,
    signal,
    submit: request.submit
  })
  let read: Awaited<ReturnType<typeof selectRuntimeEnvironmentStatus>>
  try {
    read = await waitForPromiseWithSignal(
      selectRuntimeEnvironmentStatus(environmentId, undefined, {
        ...(pairingRevision === null
          ? {}
          : { expectedEnvironmentPairingRevision: pairingRevision }),
        ...(request.operationId ? { generatedInputOperationId: request.operationId } : {})
      }),
      waiting.signal
    )
  } catch {
    // The ordinary status read failed, or this request's time ran out first: nothing was sent.
    // It says nothing about support, so neither the legacy path nor a fresh target follows.
    return 'not-sent'
  } finally {
    waiting.retire()
  }
  if (read.entry.selection?.crossedRepair) {
    // Answered by a repaired pairing's successor: it routes neither pairing. Nothing was sent;
    // the next request learns the host afresh.
    clearRuntimeCompatibilityEntry(environmentId, read.entry)
    return 'not-sent'
  }
  // The pairing main selected for that status, under this request's own id.
  pairingRevision ??= read.entry.selection?.revision ?? null
  attempt.selection = { environmentId, ...read, pairingRevision }
  return attempt.selection
}
