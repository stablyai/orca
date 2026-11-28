import { toast } from 'sonner'
import { z } from 'zod'
import { translate } from '@/i18n/i18n'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/identifiers/non-secure-context-uuid'
import { RuntimeRpcCallError, unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { pairedServerName } from '@/lib/agent-session/open/paired-server-open'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { toRemoteRuntimeClientErrorLike } from '../../../shared/remote-runtime/remote-runtime-client-error-classification'
import {
  isClientMadeFailure,
  isUnsentClientMadeFailure
} from '../../../shared/remote-runtime/rpc/runtime-rpc-client-made-failure'
import {
  HelperStopOutcome,
  isHelperStopDone
} from '../../../shared/orchestration/workers/orchestration-worker-stop-receipt'
import type { RuntimeClientTarget } from '../../../shared/remote-runtime/host-catalog/runtime-client-target'

const WorkerStopReceipt = z.object({
  state: z.string().nullish(),
  lastError: z.string().nullish(),
  warning: z.string().nullish(),
  // The host's own account of a stop it couldn't prove, such as its server not answering.
  next: z.string().nullish(),
  helperStopError: z.string().nullish(),
  // The shared contract: an outcome it doesn't know fails the parse, and so reads as unconfirmed.
  helpers: z.array(HelperStopOutcome).nullish()
})

/** Why: the Workers island deliberately doesn't offer Stop for a paired server's chat yet; that is a
 *  visible change still to be decided. Stop itself reaches a paired server (`stopOrchestrationWorker`). */
export function canStopOrchestrationWorker(target: RuntimeClientTarget): boolean {
  return target.kind === 'local'
}

const LOCAL: RuntimeClientTarget = { kind: 'local' }
// The 60 s the host itself allows a remote stop (remote-owed-actions STOP_TIMEOUT_MS), not the 15 s default.
const PAIRED_STOP_TIMEOUT_MS = 60_000

/** The worker-stop of `target`, the host that owns the Dispatch (a bot's worker, the bot's host): it closes
 *  only a proven worker and reports anything it cannot prove, a helper's stop included. `name` is the
 *  worker as its row shows it. */
export async function stopOrchestrationWorker(
  dispatchId: string,
  target: RuntimeClientTarget = LOCAL,
  name?: string
): Promise<void> {
  const call = { sent: false }
  let response: unknown
  try {
    response = await requestWorkerStop(dispatchId, target, call)
  } catch (error) {
    reportFailure(error, target, name, call.sent)
    return
  }
  const unconfirmed = unconfirmedStop(response)
  if (unconfirmed?.helper) {
    notStopped(unconfirmed.reason, helperTitle(name))
  } else if (unconfirmed) {
    notStopped(unconfirmed.reason)
  }
}

/** Unknown means unconfirmed: only proof the stop never left this computer says Orca couldn't reach the
 *  server, since a stop that left it may have stopped the worker. */
function reportFailure(
  error: unknown,
  target: RuntimeClientTarget,
  name: string | undefined,
  sent: boolean
): void {
  const message = error instanceof Error ? error.message : String(error)
  const server = target.kind === 'environment' ? pairedServerName(target.environmentId) : null
  if (!server) {
    notStopped(message)
    return
  }
  const { code } = toRemoteRuntimeClientErrorLike(error)
  const notConnected = code !== undefined && NOT_CONNECTED_CODES.has(code)
  // Before the send (its version check failed) the stop is proven unsent; after it, only the transport proves it.
  const unsent =
    !sent ||
    (error instanceof RuntimeRpcCallError && isUnsentClientMadeFailure(error.response.error))
  if (unsent && notConnected) {
    notReached(server, name)
    return
  }
  // This Orca's own timeout or lost connection after the send; the same codes from the server are its answer.
  const unanswered =
    error instanceof RuntimeRpcCallError &&
    isClientMadeFailure(error.response.error) &&
    (code === 'runtime_timeout' || code === 'remote_runtime_unavailable')
  notStopped(
    unanswered
      ? translate(
          'components.native-chat.workers.stopNoAnswer',
          "{{server}} didn't answer in time. The worker may already be stopped.",
          { server }
        )
      : message
  )
}

const NOT_CONNECTED_CODES: ReadonlySet<string> = new Set([
  'remote_runtime_unavailable',
  'runtime_timeout',
  'runtime_manually_disconnected'
])

/** What leaves the stop unproven: the worker not settled, or a helper under it whose stop isn't done
 *  (the shared receipt contract's check; a helper the user kept open is done). Null when the stop is done. */
function unconfirmedStop(response: unknown): { reason: string | null; helper: boolean } | null {
  const receipt = WorkerStopReceipt.safeParse(response)
  if (!receipt.success) {
    return { reason: null, helper: false }
  }
  const { state, lastError, warning, next, helperStopError, helpers } = receipt.data
  // A settled worker needs no stop; anything else unproven is said, never assumed.
  if (!['stopped', 'succeeded', 'failed'].includes(state ?? '')) {
    return { reason: lastError || warning || next || null, helper: false }
  }
  const helper = helpers?.find((entry) => !isHelperStopDone(entry))
  if (helperStopError || helper) {
    return { reason: helperStopError || helper?.lastError || null, helper: true }
  }
  return null
}

async function requestWorkerStop(
  dispatchId: string,
  target: RuntimeClientTarget,
  call: { sent: boolean }
): Promise<unknown> {
  const params = { dispatch: dispatchId }
  // One key per click, as on this computer, so the host keeps a receipt. A second click is a new stop.
  const requestId = createBrowserUuid()
  if (target.kind === 'environment') {
    return await callRuntimeRpc<unknown>(target, 'orchestration.workerStop', params, {
      orchestrationRequestId: requestId,
      timeoutMs: PAIRED_STOP_TIMEOUT_MS,
      // Past the version check: from here the stop may reach the server.
      beforeSend: () => {
        call.sent = true
      }
    })
  }
  call.sent = true
  const response = await window.api.runtime.call({
    method: 'orchestration.workerStop',
    params,
    orchestration: { contractVersion: ORCHESTRATION_CONTRACT_VERSION, requestId }
  })
  return unwrapRuntimeRpcResult(response)
}

function notReached(server: string, name: string | undefined): void {
  toast.error(
    translate(
      'components.native-chat.workers.stopUnreachable',
      "Orca couldn't reach {{server}} to stop {{agent}}.",
      {
        server,
        agent: name || translate('auto.lib.activateAiVaultStructuredSession.theAgent', 'the agent')
      }
    )
  )
}

function helperTitle(name: string | undefined): string {
  return translate(
    'components.native-chat.workers.stopHelperUnconfirmed',
    "Orca couldn't confirm a helper of {{agent}} stopped.",
    { agent: name || translate('auto.lib.activateAiVaultStructuredSession.theAgent', 'the agent') }
  )
}

function notStopped(
  reason: string | null,
  title = translate(
    'components.native-chat.workers.stopUnconfirmed',
    'Orca couldn’t confirm the worker stopped.'
  )
): void {
  toast.error(title, reason ? { description: reason } : undefined)
}
