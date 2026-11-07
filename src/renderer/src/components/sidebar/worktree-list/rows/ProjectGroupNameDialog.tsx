import React, { useCallback, useId, useRef, useState } from 'react'
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
import { translate } from '@/i18n/i18n'

type ProjectGroupNameDialogProps = {
  open: boolean
  sessionKey?: object
  title: string
  description: string
  initialName: string
  confirmLabel: string
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => Promise<boolean | void> | boolean | void
}

export function ProjectGroupNameDialog({
  open,
  sessionKey,
  title,
  description,
  initialName,
  confirmLabel,
  onOpenChange,
  onSubmit
}: ProjectGroupNameDialogProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const [name, setName] = useState(initialName)
  const [submitting, setSubmitting] = useState(false)
  const [previousOpenState, setPreviousOpenState] = useState({
    open,
    initialName,
    sessionKey,
    generation: 0
  })
  const generation = previousOpenState.generation
  const mountedRef = useRef(true)
  const sessionRef = useRef(0)
  const trimmedName = name.trim()

  const handleDialogContentRef = useCallback(
    (node: HTMLFormElement | null): void => {
      // Publish only the attached session so abandoned renders cannot invalidate a live save.
      mountedRef.current = node !== null
      if (node) {
        sessionRef.current = generation
      }
    },
    [generation]
  )

  // Seed before paint so selection sees the current name instead of the prior draft.
  if (
    open !== previousOpenState.open ||
    initialName !== previousOpenState.initialName ||
    sessionKey !== previousOpenState.sessionKey
  ) {
    setPreviousOpenState({ open, initialName, sessionKey, generation: generation + 1 })
    if (open) {
      setName(initialName)
      setSubmitting(false)
    }
  }

  const handleSubmit = useCallback(
    async (event?: React.FormEvent<HTMLFormElement>) => {
      event?.preventDefault()
      if (!trimmedName || submitting) {
        return
      }
      const session = generation
      setSubmitting(true)
      try {
        const confirmed = await onSubmit(trimmedName)
        if (mountedRef.current && session === sessionRef.current) {
          if (confirmed === false) {
            setSubmitting(false)
          } else {
            onOpenChange(false)
          }
        }
      } catch (error) {
        console.error('Failed to save project group name:', error)
        if (mountedRef.current && session === sessionRef.current) {
          setSubmitting(false)
        }
      }
    },
    [onOpenChange, onSubmit, submitting, trimmedName, generation]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm sm:max-w-sm"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>
        <form ref={handleDialogContentRef} className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1">
            <Label htmlFor={inputId} className="text-[11px] text-muted-foreground">
              {translate('auto.components.sidebar.ProjectGroupNameDialog.83dfbc5313', 'Group Name')}
            </Label>
            <Input
              id={inputId}
              ref={inputRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-8 text-xs"
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-xs"
              onClick={() => onOpenChange(false)}
            >
              {translate('auto.components.sidebar.ProjectGroupNameDialog.d99a034073', 'Cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              className="text-xs"
              disabled={!trimmedName || submitting}
            >
              {submitting
                ? translate(
                    'auto.components.sidebar.ProjectGroupNameDialog.4a64e78822',
                    'Saving...'
                  )
                : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
