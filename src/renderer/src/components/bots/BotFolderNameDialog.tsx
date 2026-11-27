import React, { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'

/** A name for a Bots folder, used both to create one and to rename one. */
export function BotFolderNameDialog({
  open,
  title,
  description,
  initialName,
  confirmLabel,
  nameLabel,
  onOpenChange,
  onSubmit
}: {
  open: boolean
  title: string
  description: string
  initialName: string
  confirmLabel: string
  nameLabel: string
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(initialName)
  const trimmed = name.trim()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="compact"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (trimmed !== '') {
              onSubmit(trimmed)
            }
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={inputId} variant="dialog-field">
              {nameLabel}
            </Label>
            <Input
              id={inputId}
              ref={inputRef}
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              density="compact"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"

              onClick={() => onOpenChange(false)}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={trimmed === ''}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
