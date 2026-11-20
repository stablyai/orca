import { toast } from 'sonner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { translate } from '@/i18n/i18n'

export type ZotzHostQueueAction = 'cancel' | 'forceStart' | 'dismissCanceled'

/** Act on another machine's queue; the stream of that queue then reports the result, so nothing is updated here. */
export async function runZotzHostQueueAction(
  environmentId: string,
  hostLabel: string,
  action: ZotzHostQueueAction,
  id: string
): Promise<void> {
  try {
    await callRuntimeRpc(
      { kind: 'environment', environmentId },
      `zotz.agentQueue.${action}`,
      { id },
      { timeoutMs: 10_000 }
    )
  } catch (error) {
    toast.error(
      translate('zotz.agentQueue.remoteActionFailed', 'Could not reach {{host}}: {{error}}', {
        host: hostLabel,
        error: error instanceof Error ? error.message : String(error)
      })
    )
  }
}
