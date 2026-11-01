import React, { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
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
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const [queue, setQueue] = useState<ConfirmationDialogRequest[]>([])
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
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
  const Icon = displayedRequest?.options.icon
  const compact = displayedRequest?.options.compact === true
  const buttonSize = compact ? 'sm' : 'default'
  const guarded = displayedRequest?.options.ignoresOpeningGesture === true
  // Why: the gesture that opened the prompt may still be repeating or clicking, and either answer can stick.
  const ignoreRepeatedKey = (event: React.KeyboardEvent): void => {
    if (guarded && event.repeat) {
      event.preventDefault()
    }
  }
  const isFreshClick = (event: React.MouseEvent): boolean => !guarded || event.detail <= 1

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
          if (activeRequestRef.current?.id === request.id) {
            setDontAskAgain(false)
            setFieldValues({})
          }
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

  const settleActiveRequest = useCallback(
    (confirmed: boolean) => {
      const request = activeRequestRef.current
      if (!request) {
        return
      }
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
      // Why: queued prompts must not inherit this request's preference or typed values.
      setDontAskAgain(false)
      setFieldValues({})
      request.resolve(confirmed)
      setQueue((currentQueue) => {
        if (currentQueue[0]?.id === request.id) {
          return currentQueue.slice(1)
        }
        return currentQueue.filter((queuedRequest) => queuedRequest.id !== request.id)
      })
    },
    [dontAskAgain, fieldValues]
  )

  return (
    <ConfirmationDialogContext.Provider value={confirm}>
      {children}
      <Dialog
        open={activeRequest !== null}
        onOpenChange={(open) => !open && settleActiveRequest(false)}
      >
        <DialogContent
          surface={displayedRequest?.options.surface}
          showCloseButton={false}
          size={compact ? 'compact' : 'default'}
          className={cn('sm:max-w-md', Icon && 'gap-6')}
          onInteractOutside={(event) => {
            if (guarded) {
              event.preventDefault()
            }
          }}
          onOpenAutoFocus={(event) => {
            if (activeRequest?.options.initialFocus === 'confirm') {
              event.preventDefault()
              confirmButtonRef.current?.focus()
            }
          }}
        >
          <div className={cn(Icon && 'flex items-start gap-4')}>
            {Icon && (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
                <Icon className="size-5" aria-hidden="true" />
              </div>
            )}
            <DialogHeader className={cn(Icon && 'min-w-0 gap-2 text-left')}>
              <DialogTitle size={compact ? 'compact' : 'default'}>
                {displayedRequest?.options.title}
              </DialogTitle>
              {displayedRequest?.options.description ? (
                // Callers pass multi-line descriptions (e.g. one path per line).
                <DialogDescription
                  size={compact ? 'compact' : 'default'}
                  className={cn(
                    'whitespace-pre-line',
                    displayedRequest.options.descriptionClassName
                  )}
                >
                  {displayedRequest.options.description}
                </DialogDescription>
              ) : null}
            </DialogHeader>
          </div>
          {displayedRequest?.options.fields ? (
            <div className="space-y-3">
              {displayedRequest.options.fields.inputs.map((field) => (
                <div key={field.id} className="space-y-2">
                  <Label htmlFor={`confirmation-dialog-field-${field.id}`}>{field.label}</Label>
                  <Input
                    id={`confirmation-dialog-field-${field.id}`}
                    type={field.type ?? 'text'}
                    autoComplete={field.autoComplete}
                    value={fieldValues[field.id] ?? field.defaultValue ?? ''}
                    onChange={(event) => {
                      const { value } = event.target
                      setFieldValues((current) => ({ ...current, [field.id]: value }))
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        if (!(guarded && event.repeat)) {
                          settleActiveRequest(true)
                        }
                      }
                    }}
                  />
                </div>
              ))}
            </div>
          ) : null}
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
          <DialogFooter
            className={cn(
              Icon && '-mx-6 -mb-6 rounded-b-lg border-t border-border bg-muted/30 px-6 py-4'
            )}
          >
            {displayedRequest?.options.acknowledgeOnly ? null : (
              <Button
                type="button"
                variant={displayedRequest?.options.cancelVariant ?? 'outline'}
                size={buttonSize}
                onKeyDown={ignoreRepeatedKey}
                onClick={(event) => {
                  if (!isFreshClick(event)) {
                    return
                  }
                  activeRequestRef.current?.options.onCancelClicked?.()
                  settleActiveRequest(false)
                }}
              >
                {displayedRequest?.options.cancelLabel ??
                  translate('auto.components.confirmation.dialog.56f5c60e0c', 'Cancel')}
              </Button>
            )}
            <Button
              ref={confirmButtonRef}
              type="button"
              variant={displayedRequest?.options.confirmVariant ?? 'default'}
              size={buttonSize}
              onKeyDown={ignoreRepeatedKey}
              onClick={(event) => {
                if (isFreshClick(event)) {
                  settleActiveRequest(true)
                }
              }}
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
