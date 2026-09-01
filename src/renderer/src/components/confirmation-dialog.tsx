import React, { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  ConfirmationDialogContext,
  type ConfirmationDialogContextValue,
  type ConfirmationDialogOptions
} from '@/components/confirmation-dialog-context'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type ConfirmationDialogRequest = {
  id: number
  options: ConfirmationDialogOptions
  resolve: (confirmed: boolean) => void
}

export function ConfirmationDialogProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const nextIdRef = useRef(0)
  const [queue, setQueue] = useState<ConfirmationDialogRequest[]>([])
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [optInChecked, setOptInChecked] = useState(false)
  // The ref lets the stable settle callback read the latest checkbox state.
  const optInCheckedRef = useRef(false)
  const activeRequest = queue[0] ?? null
  const activeRequestRef = useRef<ConfirmationDialogRequest | null>(activeRequest)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (s) => s.setContextualToursBlockingSurfaceVisible
  )
  const lastDisplayedRequestRef = useRef<ConfirmationDialogRequest | null>(activeRequest)
  activeRequestRef.current = activeRequest
  if (activeRequest) {
    lastDisplayedRequestRef.current = activeRequest
  }
  // Why: Radix keeps dialog content mounted while closing; keep labels stable without a post-render Effect.
  const displayedRequest = activeRequest ?? lastDisplayedRequestRef.current

  useEffect(() => {
    // Why: this provider's dialog is not represented by activeModal. Block
    // contextual tours so they cannot appear behind confirmation prompts.
    setContextualToursBlockingSurfaceVisible(activeRequest !== null)
    return () => setContextualToursBlockingSurfaceVisible(false)
  }, [activeRequest, setContextualToursBlockingSurfaceVisible])

  useEffect(() => {
    // Why: reset the opt-in to each new request's default when it becomes active;
    // skip the close transition so the box does not visibly flip while fading out.
    if (!activeRequest) {
      return
    }
    const next = activeRequest.options.optIn?.defaultChecked ?? false
    optInCheckedRef.current = next
    setOptInChecked(next)
  }, [activeRequest])

  const confirm = useCallback<ConfirmationDialogContextValue>((options) => {
    return new Promise((resolve) => {
      const request: ConfirmationDialogRequest = {
        id: nextIdRef.current,
        options,
        resolve
      }
      nextIdRef.current += 1
      setQueue((currentQueue) => [...currentQueue, request])
    })
  }, [])

  const settleActiveRequest = useCallback(
    (confirmed: boolean) => {
      const request = activeRequestRef.current
      if (!request) {
        return
      }
      if (confirmed && request.options.optIn) {
        request.options.optIn.onConfirm(optInCheckedRef.current)
      }
      // Why: cancelling must not persist a preference the user backed out of.
      if (confirmed && dontAskAgain) {
        request.options.dontAskAgain?.onConfirmed()
      }
      // Why: queued prompts must not inherit this request's preference.
      setDontAskAgain(false)
      request.resolve(confirmed)
      setQueue((currentQueue) => {
        if (currentQueue[0]?.id === request.id) {
          return currentQueue.slice(1)
        }
        return currentQueue.filter((queuedRequest) => queuedRequest.id !== request.id)
      })
    },
    [dontAskAgain]
  )

  return (
    <ConfirmationDialogContext.Provider value={confirm}>
      {children}
      <Dialog
        open={activeRequest !== null}
        onOpenChange={(open) => !open && settleActiveRequest(false)}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{displayedRequest?.options.title}</DialogTitle>
            {displayedRequest?.options.description ? (
              // Callers pass multi-line descriptions (e.g. one path per line).
              <DialogDescription
                className={cn('whitespace-pre-line', displayedRequest.options.descriptionClassName)}
              >
                {displayedRequest.options.description}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          {displayedRequest?.options.dontAskAgain ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id="confirmation-dialog-dont-ask-again"
                checked={dontAskAgain}
                onCheckedChange={(checked) => setDontAskAgain(checked === true)}
              />
              <Label
                htmlFor="confirmation-dialog-dont-ask-again"
                className="text-sm font-normal text-foreground/80"
              >
                {displayedRequest.options.dontAskAgain.label ??
                  translate('auto.components.confirmation.dialog.92bac3217e', "Don't ask again")}
              </Label>
            </div>
          ) : null}
          {displayedRequest?.options.optIn ? (
            <label className="flex cursor-pointer items-start gap-2 text-sm text-foreground">
              <Checkbox
                className="mt-0.5"
                checked={optInChecked}
                onCheckedChange={(checked) => {
                  const next = checked === true
                  optInCheckedRef.current = next
                  setOptInChecked(next)
                }}
              />
              <span>{displayedRequest.options.optIn.label}</span>
            </label>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => settleActiveRequest(false)}>
              {displayedRequest?.options.cancelLabel ??
                translate('auto.components.confirmation.dialog.56f5c60e0c', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant={displayedRequest?.options.confirmVariant ?? 'default'}
              onClick={() => settleActiveRequest(true)}
            >
              {displayedRequest?.options.confirmLabel ??
                translate('auto.components.confirmation.dialog.8490e5d36a', 'Confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmationDialogContext.Provider>
  )
}
