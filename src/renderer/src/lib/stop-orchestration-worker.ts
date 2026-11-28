import { toast } from 'sonner'
import { z } from 'zod'
import { translate } from '@/i18n/i18n'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/identifiers/non-secure-context-uuid'
import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/orchestration/orchestration-runtime-capabilities'
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
  let response: unknown
  try {
    response = await requestWorkerStop(dispatchId, target)
  } catch (error) {
    // Unknown means unconfirmed: a stop that failed may still have reached the host and stopped the
    // worker, so Orca never says it didn't. The error's own words say what went wrong.
    notStopped(error instanceof Error ? error.message : String(error))
    return
  }
  const unconfirmed = unconfirmedStop(response)
  if (unconfirmed?.helper) {
    notStopped(unconfirmed.reason, helperTitle(name))
  } else if (unconfirmed) {
    notStopped(unconfirmed.reason)
  }
}

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
  const pending = helpers?.filter((entry) => !isHelperStopDone(entry)) ?? []
  if (helperStopError || pending.length > 0) {
    // A helper that says why (unconfirmed) over one that can't yet (still starting).
    const reason = pending.find((entry) => entry.lastError)?.lastError
    return { reason: helperStopError || reason || null, helper: true }
  }
  return null
}

async function requestWorkerStop(
  dispatchId: string,
  target: RuntimeClientTarget
): Promise<unknown> {
  const params = { dispatch: dispatchId }
  // One key per click, as on this computer, so the host keeps a receipt. A second click is a new stop.
  const requestId = createBrowserUuid()
  if (target.kind === 'environment') {
    return await callRuntimeRpc<unknown>(target, 'orchestration.workerStop', params, {
      orchestrationRequestId: requestId,
      timeoutMs: PAIRED_STOP_TIMEOUT_MS
    })
  }
  const response = await window.api.runtime.call({
    method: 'orchestration.workerStop',
    params,
    orchestration: { contractVersion: ORCHESTRATION_CONTRACT_VERSION, requestId }
  })
  return unwrapRuntimeRpcResult(response)
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
