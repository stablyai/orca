import { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/non-secure-context-uuid'
import {
  GENERATED_INPUT_RUNTIME_CAPABILITY,
  splitGeneratedInputText,
  type GeneratedInputOutcome,
  type GeneratedInputRequest
} from '../../../shared/generated-terminal-input'
import { callRuntimeRpc, forgetMissingRuntimeCapability } from './runtime-rpc-client'
import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'
import { RuntimeRpcCallError, unwrapRuntimeRpcResult } from './runtime-rpc-result'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { getRemoteRuntimePtyOwner } from './runtime-terminal-stream'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  GENERATED_INPUT_FENCED_SEND_RUNTIME_CAPABILITY,
  GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY
} from '../../../shared/terminal/runtime-policy/terminal-runtime-capabilities'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import {
  clearRuntimeCompatibilityEntry,
  type RuntimeCompatibilityCacheEntry
} from './runtime-compatibility-cache'
import { noticeAudience } from './generated-input-notice-registration'
import { selectGeneratedInputRoute } from './generated-input-route-selection'
import {
  generatedInputAttempt,
  generatedInputAttemptExpired,
  generatedInputRemainingMs,
  type GeneratedInputAttempt
} from './generated-input-attempt'

type SendResult = {
  delivery?: { outcome: GeneratedInputOutcome; noticeRetained?: true }
  part?: 'accepted'
  // The host is not the runtime this request named: nothing of it was staged or written.
  refused?: 'runtime-changed'
}

// A host's terminal as only the runtime whose support was just verified may run it.
type QualifiedTerminal = { handle: string; expectedRuntimeId: string }

/** What one request is fixed to when its route is first selected, before anything is awaited:
 *  every later call of it, each part included, goes over this pairing and names this window.
 *  Null: the pairing was unknown then, so main fixes it at its first resolution instead. */
type Receipt = {
  operationId?: string
  pairingRevision: number | null
  audience: { window?: string }
}

// The ordinary status the route was chosen from: evidence a later failure may disprove.
type Selection = { entry: RuntimeCompatibilityCacheEntry; runtimeId: string | undefined }

/** Called once the host answered (never for a lost reply), with whether it kept this request's
 *  failure notice in its runtime session. */
export type HostReply = (reply: { noticeRetained: boolean }) => void

/** Where the request is going, told before it is sent: the host, whether that host keeps notices
 *  by operation id (an older one is never asked to keep a second notice), and for a paired host
 *  the receipt the request is fixed to, as far as it is known. */
export type HostRoute = (route: {
  target: RuntimeClientTarget
  keepsNotices: boolean
  receipt?: { window?: string; runtimeId?: string; pairingRevision?: number }
}) => void

// The host may wait up to the whole budget at a dialog; transport gets room beyond it.
const TRANSPORT_MARGIN_MS = 15_000

/** Hand generated text to the host that owns the PTY, which admits and writes it in one
 *  transaction. Null only when that host predates the transaction, so the caller's legacy adapter
 *  runs; every other answer, target-gone included, is the host's own outcome. */
export async function sendGeneratedTerminalInput(
  ptyId: string,
  request: GeneratedInputRequest,
  /** Cancels the host's operation (a person took the terminal over); a cancelled request's
   *  answer is lost, so it reads as unconfirmed. */
  signal?: AbortSignal,
  onReply?: HostReply,
  onRoute?: HostRoute,
  /** The accepted request this send belongs to; one is begun from `timeoutMs` when absent. */
  attempt = attemptOf(request)
): Promise<GeneratedInputOutcome | null> {
  const owner = getRemoteRuntimePtyOwner(ptyId)
  if (owner) {
    return sendGeneratedTerminalInputToHandle(
      owner.target,
      owner.terminal,
      request,
      signal,
      onReply,
      onRoute,
      attempt
    )
  }
  onRoute?.({ target: { kind: 'local' }, keepsNotices: request.retainNotice === true })
  return sendToHost(
    { kind: 'local' },
    { ptyId },
    request,
    localReceipt(request),
    attempt,
    signal,
    onReply
  )
}

/** The same operation for a caller that names a runtime terminal handle (notes). */
export async function sendGeneratedTerminalInputToHandle(
  target: RuntimeClientTarget,
  terminal: string,
  request: GeneratedInputRequest,
  signal?: AbortSignal,
  onReply?: HostReply,
  onRoute?: HostRoute,
  attempt = attemptOf(request)
): Promise<GeneratedInputOutcome | null> {
  if (target.kind !== 'environment') {
    onRoute?.({ target, keepsNotices: request.retainNotice === true })
    return sendToHost(
      target,
      { terminal },
      request,
      localReceipt(request),
      attempt,
      signal,
      onReply
    )
  }
  const { environmentId } = target
  const read = await selectGeneratedInputRoute(attempt, environmentId, request, signal)
  if (read === 'not-sent') {
    return 'not-sent'
  }
  const receipt: Receipt = {
    operationId: request.operationId,
    pairingRevision: read.pairingRevision,
    audience: request.retainNotice ? noticeAudience(target) : {}
  }
  const capabilities = read.status.capabilities ?? []
  const has = (capability: RuntimeCapability) => capabilities.includes(capability)
  if (!has(GENERATED_INPUT_RUNTIME_CAPABILITY)) {
    forgetMissingRuntimeCapability(environmentId, read)
    return null
  }
  // Only a host that itself refuses work meant for another runtime keeps notices by id: then
  // the runtime this request names is the one that runs it, whatever happens on the way.
  const fenced =
    has(GENERATED_INPUT_REGISTER_RUNTIME_CAPABILITY) &&
    has(GENERATED_INPUT_FENCED_SEND_RUNTIME_CAPABILITY)
  if (request.retainNotice === true && !fenced) {
    forgetMissingRuntimeCapability(environmentId, read)
  }
  const qualified: QualifiedTerminal | null =
    request.retainNotice === true && fenced && read.status.runtimeId
      ? { handle: terminal, expectedRuntimeId: read.status.runtimeId }
      : null
  if (!qualified) {
    // The host keeps no notice by id; the id still follows the request inside this desktop.
    const { retainNotice: _retain, operationId: _id, ...plain } = request
    request = plain
    receipt.audience = {}
  }
  onRoute?.({
    target,
    keepsNotices: qualified !== null,
    receipt: {
      ...receipt.audience,
      ...(qualified ? { runtimeId: qualified.expectedRuntimeId } : {}),
      ...(receipt.pairingRevision === null ? {} : { pairingRevision: receipt.pairingRevision })
    }
  })
  return sendToHost(
    target,
    { terminal: qualified ?? terminal },
    request,
    receipt,
    attempt,
    signal,
    onReply,
    { entry: read.entry, runtimeId: read.status.runtimeId }
  )
}

function localReceipt(request: GeneratedInputRequest): Receipt {
  return { operationId: request.operationId, pairingRevision: null, audience: {} }
}

// A caller that gave only a duration has its end fixed once, here.
function attemptOf(request: GeneratedInputRequest): GeneratedInputAttempt {
  return generatedInputAttempt(
    request.timeoutMs === undefined ? null : Date.now() + request.timeoutMs
  )
}

async function sendToHost(
  target: RuntimeClientTarget,
  address: { ptyId: string } | { terminal: string | QualifiedTerminal },
  request: GeneratedInputRequest,
  receipt: Receipt,
  attempt: GeneratedInputAttempt,
  signal?: AbortSignal,
  onReply?: HostReply,
  selection?: Selection
): Promise<GeneratedInputOutcome> {
  // The local runtime is this renderer's own version and takes the text in one request.
  const parts = target.kind === 'local' ? [request.text] : splitGeneratedInputText(request.text)
  const id = createBrowserUuid()
  // Only the last part can execute anything; until its call is handed over, nothing was sent.
  let finalHandedOver = false
  try {
    let result: SendResult = {}
    for (const [index, text] of parts.entries()) {
      const final = index === parts.length - 1
      // What is left of the attempt's one end: no part is sent after it, none with more.
      const remainingMs = generatedInputRemainingMs(attempt)
      if (remainingMs !== undefined && remainingMs < 1) {
        break
      }
      const handOver = (): void => {
        if (generatedInputAttemptExpired(attempt)) {
          throw createRuntimeRpcAbortError()
        }
        finalHandedOver = final
      }
      const params = {
        ...request,
        ...address,
        // The window its recovery belongs to travels with the request itself.
        ...receipt.audience,
        text,
        ...(remainingMs === undefined ? {} : { timeoutMs: remainingMs }),
        ...(parts.length > 1 ? { part: { id, index, final } } : {})
      }
      // Room beyond the host's own budget for its answer, which this end never cuts.
      const timeoutMs = (remainingMs ?? request.timeoutMs ?? 0) + TRANSPORT_MARGIN_MS
      result =
        signal && target.kind === 'local'
          ? await callLocalCancellable<SendResult>(
              'terminal.sendGeneratedInput',
              params,
              signal,
              handOver
            )
          : await callRuntimeRpc<SendResult>(target, 'terminal.sendGeneratedInput', params, {
              timeoutMs,
              beforeSend: handOver,
              expectedEnvironmentPairingRevision: receipt.pairingRevision,
              // Selected once for this request: never checked again against the reusable cache.
              ...(selection ? { skipCompatibilityCheck: true } : {}),
              ...(attempt.end !== null && target.kind === 'environment'
                ? { generatedInputEnd: attempt.end }
                : {}),
              ...(signal ? { signal } : {}),
              ...(receipt.operationId ? { generatedInputOperationId: receipt.operationId } : {})
            })
      if (result.refused) {
        break
      }
    }
    if (!finalHandedOver && !result.delivery && !result.refused) {
      // The attempt's end came before its last part: nothing executable was sent.
      return 'not-sent'
    }
    if (result.refused && target.kind === 'environment') {
      // Another runtime answers now: the next request learns it afresh. This one is never resent.
      forgetSelection(target.environmentId, selection)
      return 'not-sent'
    }
    if (result.delivery) {
      onReply?.({ noticeRetained: result.delivery.noticeRetained === true })
    }
    return result.delivery?.outcome ?? 'unconfirmed'
  } catch (error) {
    if (target.kind === 'environment' && disprovesSelection(error, selection)) {
      // Refused for a replaced pairing or by another runtime: the next request learns it afresh.
      forgetSelection(target.environmentId, selection)
    }
    // A part before the last only stages text, so an upload that stopped there sent nothing. A
    // lost answer to the last cannot prove nothing was written, so the text is never resent.
    return finalHandedOver ? 'unconfirmed' : 'not-sent'
  }
}

/** Authenticated evidence that the status this request was routed by no longer speaks for the
 *  environment: a replaced pairing or runtime refusal, or a failure from another runtime than it. */
function disprovesSelection(error: unknown, selection: Selection | undefined): boolean {
  if (!(error instanceof RuntimeRpcCallError)) {
    return false
  }
  if (error.code === 'runtime_environment_changed') {
    return true
  }
  const answeredBy = error.response._meta?.runtimeId
  return !!answeredBy && !!selection?.runtimeId && answeredBy !== selection.runtimeId
}

function forgetSelection(environmentId: string, selection: Selection | undefined): void {
  if (selection) {
    clearRuntimeCompatibilityEntry(environmentId, selection.entry)
  }
}

/** The same unary method over the local subscription transport, whose unsubscribe aborts the
 *  host's request context; no other wire operation is involved. */
function callLocalCancellable<T>(
  method: string,
  params: unknown,
  signal: AbortSignal,
  /** Told synchronously as the call is actually handed to IPC; never for a pre-cancelled one. */
  onIssued: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let handle: { unsubscribe: () => void } | null = null
    let settled = false
    const finish = (complete: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      handle?.unsubscribe()
      complete()
    }
    const onAbort = (): void => finish(() => reject(createRuntimeRpcAbortError()))
    if (signal.aborted) {
      return onAbort()
    }
    try {
      onIssued()
    } catch (error) {
      return reject(error)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void window.api.runtime
      .subscribe({ method, params }, (response) =>
        finish(() => {
          try {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher answers a unary method on this transport with one RuntimeRpcResponse envelope.
            resolve(unwrapRuntimeRpcResult(response as RuntimeRpcResponse<T>))
          } catch (error) {
            reject(error)
          }
        })
      )
      .then((subscription) => {
        handle = subscription
        if (settled) {
          subscription.unsubscribe()
        }
      })
      .catch((error: unknown) => finish(() => reject(error)))
  })
}
