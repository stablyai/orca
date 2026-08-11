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
import { translate } from '@/i18n/i18n'
import { stashMessagePromptCopy, type StashMessagePromptMode } from './source-control-stash-actions'

/**
 * Prompt for an optional stash name before stashing.
 *
 * Confirming with an empty field is a valid outcome — git then writes its own
 * "WIP on <branch>" subject — so it is distinct from cancelling, which aborts
 * the stash entirely.
 */
export function SourceControlStashMessageDialog({
  mode,
  onSubmit,
  onCancel
}: {
  mode: StashMessagePromptMode | null
  onSubmit: (message: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const [message, setMessage] = useState('')

  // Why: each open starts fresh; a leftover name from the previous stash would
  // silently attach itself to this one.
  useEffect(() => {
    if (mode) {
      setMessage('')
    }
  }, [mode])

  const copy = stashMessagePromptCopy(mode ?? 'stash')

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) {
          onCancel()
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onSubmit(message)
            }
          }}
          placeholder={translate(
            'auto.components.right.sidebar.SourceControlStashMessageDialog.placeholder',
            'Stash message'
          )}
          data-testid="source-control-stash-message-input"
        />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {translate(
              'auto.components.right.sidebar.SourceControlStashMessageDialog.cancel',
              'Cancel'
            )}
          </Button>
          <Button
            type="button"
            onClick={() => onSubmit(message)}
            data-testid="source-control-stash-message-confirm"
          >
            {copy.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
