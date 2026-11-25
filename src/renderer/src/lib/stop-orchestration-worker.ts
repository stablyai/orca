import { toast } from 'sonner'
import { z } from 'zod'
import { translate } from '@/i18n/i18n'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/identifiers/non-secure-context-uuid'
import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
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

/** The host's own worker-stop: it closes only a proven worker and reports anything it cannot prove. */
export async function stopOrchestrationWorker(dispatchId: string): Promise<void> {
  try {
    const response = await window.api.runtime.call({
      method: 'orchestration.workerStop',
      params: { dispatch: dispatchId },
      orchestration: {
        contractVersion: ORCHESTRATION_CONTRACT_VERSION,
        requestId: createBrowserUuid()
      }
    })
    const receipt = WorkerStopReceipt.safeParse(unwrapRuntimeRpcResult(response))
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

function notStopped(reason: string | null): void {
  toast.error(
    translate(
      'components.native-chat.workers.stopUnconfirmed',
      'Orca couldn’t confirm the worker stopped.'
    ),
    reason ? { description: reason } : undefined
  )
}
