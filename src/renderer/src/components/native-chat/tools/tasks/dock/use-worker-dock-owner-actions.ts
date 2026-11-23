import { useCallback, useRef, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  WorkerDockResult,
  type WorkerDockSnapshot
} from '../../../../../../../shared/orchestration/dock/worker-dock'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { createNonSecureContextUuid } from '../../../../../../../shared/identifiers/non-secure-context-uuid'
import type { WorkerDockRowView } from './WorkerDockRow'

/** A strip failure and the retry of the request that failed; no retry when none applies. */
export type WorkerDockFailure = { message: string; retry?: () => void }
export type WorkerDockResultDialogState = {
  token: number
  row: WorkerDockRowView
  opener: HTMLElement
  result: WorkerDockResult | null
  error: string | null
}

const message = (value: unknown) => (value instanceof Error ? value.message : String(value))

export function useWorkerDockOwnerActions(
  target: RuntimeClientTarget,
  party: string | null | undefined,
  identities: WorkerDockSnapshot['identities'] | undefined,
  workerOpen: (row: WorkerDockRowView) => void
) {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [failure, setFailure] = useState<WorkerDockFailure | null>(null)
  const [dialog, setDialog] = useState<WorkerDockResultDialogState | null>(null)
  // Each open owns one token; a read or Restore that settles after close or another open is dropped.
  const dialogToken = useRef(0)
  const updateDialog = useCallback(
    (token: number, patch: Partial<WorkerDockResultDialogState>) =>
      setDialog((current) => (current?.token === token ? { ...current, ...patch } : current)),
    []
  )
  const open = useCallback(
    (row: WorkerDockRowView, opener: HTMLElement) => {
      if (!party) {
        return
      }
      if (!row.resultId && !row.settlement && !row.retired) {
        workerOpen(row)
        return
      }
      const token = ++dialogToken.current
      setDialog({ token, row, opener, result: null, error: null })
      void callRuntimeRpc(target, 'orchestration.workerDockResult', {
        party,
        dispatch: row.dispatchId
      }).then(
        (value) => {
          const parsed = WorkerDockResult.safeParse(value)
          updateDialog(
            token,
            parsed.success && parsed.data.dispatchId === row.dispatchId
              ? { result: parsed.data }
              : { error: row.reason ?? 'The saved result is not available yet. Try again.' }
          )
        },
        (value) => updateDialog(token, { error: message(value) })
      )
    },
    [party, target, workerOpen, updateDialog]
  )
  const close = useCallback(() => {
    dialogToken.current++
    setDialog(null)
  }, [])
  const acknowledge = useCallback(
    async (settlements: { dispatchId: string; settlement: string }[], acknowledged = true) => {
      if (!party) {
        return
      }
      for (let offset = 0; offset < settlements.length; offset += 1000) {
        await callRuntimeRpc(target, 'orchestration.workerDockAcknowledge', {
          party,
          settlements: settlements.slice(offset, offset + 1000),
          acknowledged
        })
      }
    },
    [party, target]
  )
  const track = useCallback((ids: ReadonlySet<string>, request: () => Promise<unknown>) => {
    const attempt = () => {
      setFailure(null)
      setPending((current) => new Set([...current, ...ids]))
      void request()
        .catch((value) => setFailure({ message: message(value), retry: attempt }))
        .finally(() => setPending((current) => new Set([...current].filter((id) => !ids.has(id)))))
    }
    attempt()
  }, [])
  const action = useCallback(
    (row: WorkerDockRowView, kind: 'stop' | 'clear') => {
      if (!party) {
        return
      }
      const requestId = createNonSecureContextUuid()
      const settlement = kind === 'clear' ? row.settlement : undefined
      track(new Set([row.id]), () =>
        settlement
          ? acknowledge([{ dispatchId: row.dispatchId, settlement }])
          : callRuntimeRpc(target, 'orchestration.workerDockStop', {
              party,
              dispatch: row.dispatchId,
              requestId
            })
      )
    },
    [acknowledge, party, target, track]
  )
  const clearAll = useCallback(() => {
    const captured = (identities ?? []).flatMap((row) =>
      row.settlement && (row.state === 'failed' || row.state === 'unexpected')
        ? [{ dispatchId: row.dispatchId, settlement: row.settlement }]
        : []
    )
    const capturedDispatches = new Set(captured.map((item) => item.dispatchId))
    const capturedIds = new Set(
      (identities ?? [])
        .filter((row) => capturedDispatches.has(row.dispatchId))
        .map((row) => row.id)
    )
    track(capturedIds, () => acknowledge(captured))
  }, [acknowledge, identities, track])
  const restore = useCallback(() => {
    const shown = dialog?.result
    if (!dialog || !shown || shown.dispatchId !== dialog.row.dispatchId) {
      return
    }
    const { token } = dialog
    void acknowledge([{ dispatchId: shown.dispatchId, settlement: shown.settlement }], false).then(
      () => updateDialog(token, { result: { ...shown, acknowledged: false } }),
      (value) =>
        dialogToken.current === token
          ? updateDialog(token, { error: message(value) })
          : setFailure({ message: message(value) })
    )
  }, [acknowledge, dialog, updateDialog])
  return {
    pending,
    failure,
    dismissFailure: () => setFailure(null),
    dialog,
    open,
    close,
    action,
    clearAll,
    restore
  }
}
