import { toast } from 'sonner'
import { z } from 'zod'
import { translate } from '@/i18n/i18n'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/identifiers/non-secure-context-uuid'
import { RuntimeRpcCallError, unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { pairedServerName } from '@/lib/agent-session/open/paired-server-open'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime/remote-runtime-client-error-classification'
import { isClientMadeFailure } from '../../../shared/remote-runtime/rpc/runtime-rpc-client-made-failure'
import type { RuntimeClientTarget } from '../../../shared/remote-runtime/host-catalog/runtime-client-target'

const WorkerStopReceipt = z.object({
  state: z.string().nullish(),
  lastError: z.string().nullish(),
  warning: z.string().nullish(),
  helperStopError: z.string().nullish(),
  helpers: z.array(z.object({ outcome: z.string(), lastError: z.string().nullish() })).nullish()
})
type WorkerStopReceipt = z.infer<typeof WorkerStopReceipt>

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
 *  worker as its row shows it, for a paired server that can't be reached. */
export async function stopOrchestrationWorker(
  dispatchId: string,
  target: RuntimeClientTarget = LOCAL,
  name?: string
): Promise<void> {
  let response: unknown
  try {
    response = await requestWorkerStop(dispatchId, target)
  } catch (error) {
    // A server that never answered is named; any answer it gave is its own to explain.
    const serverName =
      target.kind === 'environment' && noAnswer(error)
        ? pairedServerName(target.environmentId)
        : null
    if (serverName) {
      notReached(serverName, name)
    } else {
      notStopped(error instanceof Error ? error.message : String(error))
    }
    return
  }
  const unconfirmed = unconfirmedStop(response)
  if (unconfirmed) {
    notStopped(unconfirmed.reason)
  }
}

/** What leaves the stop unproven: the worker not settled, or a helper under it (as worker-stop's CLI
 *  failure reads it). Null when the stop is done. */
function unconfirmedStop(response: unknown): { reason: string | null } | null {
  const receipt = WorkerStopReceipt.safeParse(response)
  if (!receipt.success) {
    return { reason: null }
  }
  const { state, lastError, warning, helperStopError, helpers } = receipt.data
  // A settled worker needs no stop; anything else unproven is said, never assumed.
  if (!['stopped', 'succeeded', 'failed'].includes(state ?? '')) {
    return { reason: lastError || warning || null }
  }
  const helper = helpers?.find((entry) => entry.outcome === 'unconfirmed')
  if (helperStopError || helper) {
    return { reason: helperStopError || helper?.lastError || null }
  }
  return null
}

/** The call never got an answer: the server is off, asleep, disconnected, or timed out. The same
 *  codes from the server itself are its answer about another computer it couldn't reach. */
function noAnswer(error: unknown): boolean {
  if (error instanceof RuntimeRpcCallError && !isClientMadeFailure(error.response.error)) {
    return false
  }
  const like = toRemoteRuntimeClientErrorLike(error)
  return (
    like.code === 'runtime_manually_disconnected' || isRecoverableRemoteRuntimeConnectionError(like)
  )
}

async function requestWorkerStop(
  dispatchId: string,
  target: RuntimeClientTarget
): Promise<unknown> {
  const params = { dispatch: dispatchId }
  // One key per click, as on this computer: the host keeps its receipt, and a resend replays it.
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

function notStopped(reason: string | null): void {
  toast.error(
    translate(
      'components.native-chat.workers.stopUnconfirmed',
      'Orca couldn’t confirm the worker stopped.'
    ),
    reason ? { description: reason } : undefined
  )
}
