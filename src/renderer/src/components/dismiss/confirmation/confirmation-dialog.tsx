import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import {
  ConfirmationDialogContext,
  type ConfirmationDialogContextValue
} from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useAppStore } from '@/store/index'
import type { ConfirmationDialogRequest } from './ConfirmationDialogSurface'

const LazyConfirmationDialogSurface = lazyWithRetry(
  () =>
    import('./ConfirmationDialogSurface').then((module) => ({
      default: module.ConfirmationDialogSurface
    })),
  { reloadKey: 'confirmation-dialog-surface' }
)

export function ConfirmationDialogProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const nextIdRef = useRef(0)
  const [queue, setQueue] = useState<ConfirmationDialogRequest[]>([])
  const activeRequest = queue[0] ?? null
  const hasOpened = useLatchedOpen(activeRequest !== null)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (s) => s.setContextualToursBlockingSurfaceVisible
  )

  useEffect(() => {
    // This dialog bypasses activeModal; block contextual tours explicitly while it is open.
    setContextualToursBlockingSurfaceVisible(activeRequest !== null)
    return () => setContextualToursBlockingSurfaceVisible(false)
  }, [activeRequest, setContextualToursBlockingSurfaceVisible])

  const confirm = useCallback<ConfirmationDialogContextValue>((options) => {
    return new Promise((resolve) => {
      const { signal } = options
      if (signal?.aborted) {
        resolve(false)
        return
      }
      const request: ConfirmationDialogRequest = {
        id: nextIdRef.current,
        options,
        resolve
      }
      nextIdRef.current += 1
      signal?.addEventListener(
        'abort',
        () => {
          resolve(false)
          setQueue((currentQueue) =>
            currentQueue.filter((queuedRequest) => queuedRequest.id !== request.id)
          )
        },
        { once: true }
      )
      setQueue((currentQueue) => [...currentQueue, request])
    })
  }, [])

  const settleRequest = useCallback(
    (
      request: ConfirmationDialogRequest,
      confirmed: boolean,
      dontAskAgain: boolean,
      fieldValues: Record<string, string>
    ) => {
      // Why: cancelling must not persist a preference the user backed out of.
      if (confirmed && dontAskAgain) {
        request.options.dontAskAgain?.onConfirmed()
      }
      const fields = request.options.fields
      if (confirmed && fields) {
        const defaults = Object.fromEntries(
          fields.inputs.map((field) => [field.id, field.defaultValue ?? ''])
        )
        fields.onConfirmed({ ...defaults, ...fieldValues })
      }
      request.resolve(confirmed)
      setQueue((currentQueue) => {
        if (currentQueue[0]?.id === request.id) {
          return currentQueue.slice(1)
        }
        return currentQueue.filter((queuedRequest) => queuedRequest.id !== request.id)
      })
    },
    []
  )

  return (
    <ConfirmationDialogContext.Provider value={confirm}>
      {children}
      {hasOpened ? (
        <Suspense fallback={null}>
          <LazyConfirmationDialogSurface activeRequest={activeRequest} onSettle={settleRequest} />
        </Suspense>
      ) : null}
    </ConfirmationDialogContext.Provider>
  )
}
