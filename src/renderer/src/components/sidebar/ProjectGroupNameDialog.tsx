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
  title: string
  description: string
  initialName: string
  confirmLabel: string
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => Promise<void> | void
}

export function ProjectGroupNameDialog({
  open,
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
  const [previousOpenState, setPreviousOpenState] = useState({ open, initialName })
  const mountedRef = useRef(true)
  const trimmedName = name.trim()

  const handleDialogContentRef = useCallback((node: HTMLDivElement | null): void => {
    // Why: save can finish after the dialog closes; the content ref keeps late
    // completions from mutating stale dialog state without an Effect.
    mountedRef.current = node !== null
  }, [])

  // Why: the input should mount already seeded and selectable for the active
  // group; Effect-based hydration shows one frame with the prior draft.
  if (open !== previousOpenState.open || initialName !== previousOpenState.initialName) {
    setPreviousOpenState({ open, initialName })
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
      setSubmitting(true)
      try {
        await onSubmit(trimmedName)
        if (mountedRef.current) {
          onOpenChange(false)
        }
      } catch (error) {
        console.error('Failed to save project group name:', error)
        if (mountedRef.current) {
          setSubmitting(false)
        }
      }
    },
    [onOpenChange, onSubmit, submitting, trimmedName]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={handleDialogContentRef}
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
        <form className="space-y-4" onSubmit={handleSubmit}>
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
