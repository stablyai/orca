import { toast } from 'sonner'
import { z } from 'zod'
import { translate } from '@/i18n/i18n'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/identifiers/non-secure-context-uuid'
import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../shared/remote-runtime/host-catalog/runtime-client-target'

const WorkerStopReceipt = z.object({
  state: z.string().nullish(),
  lastError: z.string().nullish(),
  warning: z.string().nullish()
})
type WorkerStopReceipt = z.infer<typeof WorkerStopReceipt>

/** Only this computer's runtime takes a Stop from here; a paired server's worker is stopped there. */
export function canStopOrchestrationWorker(target: RuntimeClientTarget): boolean {
  return target.kind === 'local'
}

const LOCAL: RuntimeClientTarget = { kind: 'local' }

/** The worker-stop of `target`, the host that owns the Dispatch (a bot's worker, the bot's host): it closes
 *  only a proven worker and reports anything it cannot prove. */
export async function stopOrchestrationWorker(
  dispatchId: string,
  target: RuntimeClientTarget = LOCAL
): Promise<void> {
  try {
    const receipt = WorkerStopReceipt.safeParse(await requestWorkerStop(dispatchId, target))
    const field = (key: keyof WorkerStopReceipt): string | null =>
      (receipt.success ? receipt.data[key] : null) || null
    // A settled worker needs no stop; anything else unproven is said, never assumed.
    if (!['stopped', 'succeeded', 'failed'].includes(field('state') ?? '')) {
      notStopped(field('lastError') ?? field('warning'))
    }
  } catch (error) {
    notStopped(error instanceof Error ? error.message : String(error))
  }
}

async function requestWorkerStop(
  dispatchId: string,
  target: RuntimeClientTarget
): Promise<unknown> {
  const params = { dispatch: dispatchId }
  if (target.kind === 'environment') {
    // The bridge to a paired host adds the contract version but no request id, so the stop keeps no receipt there.
    return await callRuntimeRpc<unknown>(target, 'orchestration.workerStop', params)
  }
  const response = await window.api.runtime.call({
    method: 'orchestration.workerStop',
    params,
    orchestration: {
      contractVersion: ORCHESTRATION_CONTRACT_VERSION,
      requestId: createBrowserUuid()
    }
  })
  return unwrapRuntimeRpcResult(response)
}

function notStopped(reason: string | null): void {
  toast.error(
    translate(
      'components.native-chat.workers.stopUnconfirmed',
      'Orca couldn’t confirm the worker stopped.'
    ),
    reason ? { description: reason } : undefined
  )
}
