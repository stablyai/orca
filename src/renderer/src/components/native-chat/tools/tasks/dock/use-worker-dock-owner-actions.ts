import { useCallback, useMemo, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  workerDockClearable,
  type WorkerDockSnapshot
} from '../../../../../../../shared/orchestration/dock/worker-dock'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { createNonSecureContextUuid } from '../../../../../../../shared/identifiers/non-secure-context-uuid'
import type { WorkerDockRowView } from './WorkerDockRow'
import type { WorkerDockStopBlock } from './worker-dock-stop-check'
import {
  KEPT_PROMPT_VIEWS,
  useNativeChatViewGuard
} from '../../../pane/ownership/native-chat-view-memory'

/** A strip failure and the retry of the request that failed; no retry when none applies. */
export type WorkerDockFailure = { message: string; retry?: () => void }
const NO_PENDING: ReadonlySet<string> = new Set()
const message = (value: unknown) => (value instanceof Error ? value.message : String(value))
/** A failure no Retry can change, such as a Stop for a worker that has already settled. */
class FinalWorkerDockError extends Error {}

export function useWorkerDockOwnerActions(
  target: RuntimeClientTarget,
  party: string | null | undefined,
  identities: WorkerDockSnapshot['identities'] | undefined,
  /** Read just before each Stop request and each Retry of it, so neither is sent once the
   *  pressed row can't stop. */
  stopBlock?: (row: WorkerDockRowView, party: string) => WorkerDockStopBlock
) {
  const t = useTranslate()
  // Kept with the chat tab: a dock released mid-request returns with those rows still pending.
  const [pending, setPending] = useNativeChatViewGuard('worker-dock-pending', NO_PENDING)
  // Kept with it, so a request failing while the chat is switched away still says why on return. Only the message:
  // Retry stays with the view that made it, whose stop check is current.
  const [kept, setKept] = useNativeChatViewGuard<{ message: string } | null>(
    'worker-dock-failure',
    null,
    KEPT_PROMPT_VIEWS
  )
  const [retryOf, setRetryOf] = useState<{ failure: object; retry: () => void } | null>(null)
  const failure = useMemo<WorkerDockFailure | null>(
    () =>
      kept && {
        message: kept.message,
        ...(retryOf?.failure === kept ? { retry: retryOf.retry } : {})
      },
    [kept, retryOf]
  )
  const acknowledge = useCallback(
    async (settlements: { dispatchId: string; settlement: string }[]) => {
      if (!party) {
        return
      }
      for (let offset = 0; offset < settlements.length; offset += 1000) {
        await callRuntimeRpc(target, 'orchestration.workerDockAcknowledge', {
          party,
          settlements: settlements.slice(offset, offset + 1000),
          acknowledged: true
        })
      }
    },
    [party, target]
  )
  const track = useCallback(
    (ids: ReadonlySet<string>, request: () => Promise<unknown>) => {
      const attempt = () => {
        setKept(null)
        setPending((current) => new Set([...current, ...ids]))
        void request()
          .catch((value) => {
            const failed = { message: message(value) }
            setKept(failed)
            setRetryOf(
              value instanceof FinalWorkerDockError ? null : { failure: failed, retry: attempt }
            )
          })
          .finally(() =>
            setPending((current) => {
              const left = new Set([...current].filter((id) => !ids.has(id)))
              // Back at the empty default, the kept entry is deleted.
              return left.size === 0 ? NO_PENDING : left
            })
          )
      }
      attempt()
    },
    [setKept, setPending]
  )
  const action = useCallback(
    (row: WorkerDockRowView, kind: 'stop' | 'clear') => {
      // Clear only acknowledges; a row with no settlement has nothing to clear and must not Stop.
      if (!party || (kind === 'clear' && !row.settlement)) {
        return
      }
      const requestId = createNonSecureContextUuid()
      const settlement = kind === 'clear' ? row.settlement : null
      track(new Set([row.id]), () => {
        if (settlement) {
          return acknowledge([{ dispatchId: row.dispatchId, settlement }])
        }
        const block = stopBlock?.(row, party)
        return block
          ? Promise.reject(
              block === 'settled'
                ? new FinalWorkerDockError(
                    t('components.native-chat.workerDock.alreadyStopped', 'Already stopped')
                  )
                : new Error(t('components.native-chat.workerDock.cantStop', "Can't stop now"))
            )
          : callRuntimeRpc(target, 'orchestration.workerDockStop', {
              party,
              dispatch: row.dispatchId,
              requestId
            })
      })
    },
    [acknowledge, party, stopBlock, t, target, track]
  )
  const clearAll = useCallback(() => {
    const captured = (identities ?? []).flatMap((row) =>
      workerDockClearable(row) ? [{ dispatchId: row.dispatchId, settlement: row.settlement }] : []
    )
    const capturedDispatches = new Set(captured.map((item) => item.dispatchId))
    const capturedIds = new Set(
      (identities ?? [])
        .filter((row) => capturedDispatches.has(row.dispatchId))
        .map((row) => row.id)
    )
    if (captured.length) {
      track(capturedIds, () => acknowledge(captured))
    }
  }, [acknowledge, identities, track])
  return {
    pending,
    failure,
    dismissFailure: () => setKept(null),
    action,
    clearAll
  }
}
