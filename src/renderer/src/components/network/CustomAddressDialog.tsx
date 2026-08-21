import React, { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2 } from 'lucide-react'

export type CustomAddressValidator = (input: string) => { ok: true; value: string } | { ok: false }

export type CustomAddressDialogCopy = {
  title: string
  description: string
  inputLabel: string
  placeholder: string
  hint: string
  cancel: string
  confirm: string
  confirmationError?: string
}

type CustomAddressDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Why: prefill from the current selection when it is already a custom value
  // so reopening to edit shows what is in use rather than a blank field.
  initialValue?: string
  validate: CustomAddressValidator
  copy: CustomAddressDialogCopy
  inputId: string
  onConfirm: (value: string) => boolean | void | Promise<boolean | void>
}

// Why: surfaces inject their own grammar and copy; Mobile accepts IPv4/IPv6,
// hostnames, and full HTTP(S)/WebSocket URLs.
export function CustomAddressDialog({
  open,
  onOpenChange,
  initialValue,
  validate,
  copy,
  inputId,
  onConfirm
}: CustomAddressDialogProps): React.JSX.Element {
  const [value, setValue] = useState(initialValue ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [confirmationFailed, setConfirmationFailed] = useState(false)

  // Why: reseed each time the dialog opens so a prior cancelled edit doesn't
  // leak into the next open.
  useEffect(() => {
    if (open) {
      setValue(initialValue ?? '')
    }
  }, [open, initialValue])

  const close = (): void => {
    setSubmitting(false)
    setConfirmationFailed(false)
    onOpenChange(false)
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (nextOpen) {
      onOpenChange(true)
    } else if (!submitting) {
      close()
    }
  }

  const parsed = validate(value)
  // Why: only flag invalid input once the user has typed something — an empty
  // field on open shouldn't read as an error.
  const showInvalid = value.trim() !== '' && !parsed.ok

  const submit = async (): Promise<void> => {
    if (!parsed.ok || submitting) {
      return
    }
    setSubmitting(true)
    setConfirmationFailed(false)
    try {
      if ((await onConfirm(parsed.value)) !== false) {
        close()
      } else {
        setConfirmationFailed(true)
      }
    } catch {
      setConfirmationFailed(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={inputId}>{copy.inputLabel}</Label>
          <Input
            id={inputId}
            autoFocus
            value={value}
            disabled={submitting}
            aria-invalid={showInvalid}
            placeholder={copy.placeholder}
            onChange={(e) => {
              setValue(e.target.value)
              setConfirmationFailed(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submit()
              }
            }}
          />
          {/* Why: neutral helper copy that doubles as validation guidance —
              kept muted (not destructive-red) so a half-typed value doesn't
              feel like a hard error. */}
          <p className="text-xs text-muted-foreground">{copy.hint}</p>
          {confirmationFailed ? (
            <p className="text-xs text-destructive" role="alert">
              {copy.confirmationError ?? copy.hint}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={close}>
            {copy.cancel}
          </Button>
          <Button type="button" disabled={!parsed.ok || submitting} onClick={() => void submit()}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
