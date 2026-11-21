import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

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
import { DialogCancel } from '@/components/ui/dialog-parts'
import {
  ConfirmationDialogContext,
  type ConfirmationDialogContextValue,
  type ConfirmationDialogOptions
} from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

function ConfirmationHeader({
  options,
  className
}: {
  options: ConfirmationDialogOptions | undefined
  className?: string
}): React.JSX.Element {
  return (
    <DialogHeader className={className}>
      <DialogTitle>{options?.title}</DialogTitle>
      {options?.subtitle ? (
        <div className="min-w-0 text-[13px] leading-normal text-muted-foreground">
          {options.subtitle}
        </div>
      ) : null}
      {options?.description ? (
        // Callers pass multi-line descriptions (e.g. one path per line) and their own wrapping.
        <DialogDescription>
          <span className={cn('block whitespace-pre-line', options.descriptionClassName)}>
            {options.description}
          </span>
        </DialogDescription>
      ) : null}
    </DialogHeader>
  )
}

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
  const t = useTranslate()
  const nextIdRef = useRef(0)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)
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
  const options = displayedRequest?.options
  // Why Cancel: the "Don't ask again" checkbox now comes first, and Enter must not confirm by accident.
  const initialFocus = options?.initialFocus ?? (options?.fields ? undefined : 'cancel')
  const activeRequestId = activeRequest?.id
  useLayoutEffect(() => {
    if (activeRequestId === undefined) {
      return
    }
    const target =
      initialFocus === 'confirm'
        ? confirmButtonRef.current
        : initialFocus === 'cancel'
          ? (cancelButtonRef.current ?? confirmButtonRef.current)
          : firstInputRef.current
    target?.focus()
  }, [activeRequestId, initialFocus])
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
          size="confirm"
          surface={options?.surface}
          initialFocus={initialFocus === 'cancel' ? 'cancel' : undefined}
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
          {options?.media ? (
            <div className="flex min-w-0 items-center gap-3">
              {options.media}
              <ConfirmationHeader options={options} className="min-w-0 flex-1" />
            </div>
          ) : (
            <ConfirmationHeader options={options} />
          )}
          {options?.details}
          {options?.fields ? (
            <div className="space-y-3">
              {options.fields.inputs.map((field, index) => (
                <div key={field.id} className="space-y-2">
                  <Label htmlFor={`confirmation-dialog-field-${field.id}`}>{field.label}</Label>
                  <Input
                    ref={index === 0 ? firstInputRef : undefined}
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
          <DialogFooter
            start={
              options?.dontAskAgain ? (
                <>
                  <Checkbox
                    id="confirmation-dialog-dont-ask-again"
                    checked={dontAskAgain}
                    onCheckedChange={(checked) => setDontAskAgain(checked === true)}
                  />
                  <Label htmlFor="confirmation-dialog-dont-ask-again" variant="dialog-muted">
                    {options.dontAskAgain.label ??
                      t('auto.components.confirmation.dialog.92bac3217e', "Don't ask again")}
                  </Label>
                </>
              ) : null
            }
          >
            {options?.acknowledgeOnly ? null : (
              <DialogCancel
                ref={cancelButtonRef}
                onKeyDown={ignoreRepeatedKey}
                onClick={(event) => {
                  event.preventDefault()
                  if (!isFreshClick(event)) {
                    return
                  }
                  activeRequestRef.current?.options.onCancelClicked?.()
                  settleActiveRequest(false)
                }}
              >
                {options?.cancelLabel ??
                  t('auto.components.confirmation.dialog.56f5c60e0c', 'Cancel')}
              </DialogCancel>
            )}
            <Button
              ref={confirmButtonRef}
              type="button"
              size="sm"
              variant={options?.confirmVariant ?? 'default'}
              onKeyDown={ignoreRepeatedKey}
              onClick={(event) => {
                if (isFreshClick(event)) {
                  settleActiveRequest(true)
                }
              }}
            >
              {options?.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmationDialogContext.Provider>
  )
}
