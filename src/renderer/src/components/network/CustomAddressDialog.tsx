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

export type CustomAddressValidator = (input: string) => { ok: true; value: string } | { ok: false }

export type CustomAddressDialogCopy = {
  title: string
  description: string
  inputLabel: string
  placeholder: string
  hint: string
  cancel: string
  confirm: string
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
  onConfirm: (value: string) => void
}

// Why: shared single-field modal for entering a custom address/endpoint. The
// grammar differs per surface (mobile takes IPv4/Tailscale; the server-share
// form takes host / host:port / wss URLs), so validation and copy are injected
// rather than baked in.
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

  // Why: reseed each time the dialog opens so a prior cancelled edit doesn't
  // leak into the next open.
  useEffect(() => {
    if (open) {
      setValue(initialValue ?? '')
    }
  }, [open, initialValue])

  const parsed = validate(value)
  // Why: only flag invalid input once the user has typed something — an empty
  // field on open shouldn't read as an error.
  const showInvalid = value.trim() !== '' && !parsed.ok

  const submit = (): void => {
    if (!parsed.ok) {
      return
    }
    onConfirm(parsed.value)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
            aria-invalid={showInvalid}
            placeholder={copy.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
          />
          {/* Why: neutral helper copy that doubles as validation guidance —
              kept muted (not destructive-red) so a half-typed value doesn't
              feel like a hard error. */}
          <p className="text-xs text-muted-foreground">{copy.hint}</p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {copy.cancel}
          </Button>
          <Button type="button" disabled={!parsed.ok} onClick={submit}>
            {copy.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
