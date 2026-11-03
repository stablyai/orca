import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  GENERATED_INPUT_RUNTIME_CAPABILITY,
  splitGeneratedInputText,
  type GeneratedInputOutcome,
  type GeneratedInputRequest
} from '../../../shared/generated-terminal-input'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { getRemoteRuntimePtyOwner } from './runtime-terminal-stream'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

type SendResult = {
  delivery?: { outcome: GeneratedInputOutcome; noticeRetained?: true }
  part?: 'accepted'
}

/** Called once the host answered (never for a lost reply), with whether it kept this request's
 *  failure notice in its runtime session. */
export type HostReply = (reply: { noticeRetained: boolean }) => void

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
  onReply?: HostReply
): Promise<GeneratedInputOutcome | null> {
  const owner = getRemoteRuntimePtyOwner(ptyId)
  return owner
    ? sendGeneratedTerminalInputToHandle(owner.target, owner.terminal, request, signal, onReply)
    : sendToHost({ kind: 'local' }, { ptyId }, request, signal, onReply)
}

/** The same operation for a caller that names a runtime terminal handle (notes). */
export async function sendGeneratedTerminalInputToHandle(
  target: RuntimeClientTarget,
  terminal: string,
  request: GeneratedInputRequest,
  signal?: AbortSignal,
  onReply?: HostReply
): Promise<GeneratedInputOutcome | null> {
  if (
    target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      GENERATED_INPUT_RUNTIME_CAPABILITY
    ))
  ) {
    return null
  }
  return sendToHost(target, { terminal }, request, signal, onReply)
}

async function sendToHost(
  target: RuntimeClientTarget,
  address: { ptyId: string } | { terminal: string },
  request: GeneratedInputRequest,
  signal?: AbortSignal,
  onReply?: HostReply
): Promise<GeneratedInputOutcome> {
  const timeoutMs = (request.timeoutMs ?? 0) + TRANSPORT_MARGIN_MS
  // The local runtime is this renderer's own version and takes the text in one request.
  const parts = target.kind === 'local' ? [request.text] : splitGeneratedInputText(request.text)
  const id = createBrowserUuid()
  try {
    let result: SendResult = {}
    for (const [index, text] of parts.entries()) {
      const params = {
        ...request,
        ...address,
        text,
        ...(parts.length > 1 ? { part: { id, index, final: index === parts.length - 1 } } : {})
      }
      result =
        signal && target.kind === 'local'
          ? await callLocalCancellable<SendResult>('terminal.sendGeneratedInput', params, signal)
          : await callRuntimeRpc<SendResult>(target, 'terminal.sendGeneratedInput', params, {
              timeoutMs,
              ...(signal ? { signal } : {})
            })
    }
    if (result.delivery) {
      onReply?.({ noticeRetained: result.delivery.noticeRetained === true })
    }
    return result.delivery?.outcome ?? 'unconfirmed'
  } catch {
    // A lost answer cannot prove nothing was written, so the text is never sent again here.
    return 'unconfirmed'
  }
}

/** The same unary method over the local subscription transport, whose unsubscribe aborts the
 *  host's request context; no other wire operation is involved. */
function callLocalCancellable<T>(method: string, params: unknown, signal: AbortSignal): Promise<T> {
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
