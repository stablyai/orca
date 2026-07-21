import { useCallback, useState } from 'react'
import { translate } from '@/i18n/i18n'
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

/**
 * The pet's ask box.
 *
 * Deliberately a dialog and not an inline field on the bubble: the pet is a
 * ~48px sprite that roams, so an inline input would move out from under the
 * cursor mid-typing. The dialog also gives the prompt a real focus trap, which
 * matters because the pet floats over the terminal — keystrokes that escaped it
 * would land in whatever pane is behind the pet.
 */
export function PetAskDialog({
  open,
  agentLabel,
  onOpenChange,
  onSubmit
}: {
  open: boolean
  agentLabel: string
  onOpenChange: (open: boolean) => void
  onSubmit: (prompt: string) => void
}): React.JSX.Element {
  const [prompt, setPrompt] = useState('')

  const close = useCallback(
    (next: boolean): void => {
      onOpenChange(next)
      if (!next) {
        // Why clear on close: the pet's target can change between openings, and
        // a stale draft would silently be delivered to a different agent than
        // the one it was written for.
        setPrompt('')
      }
    },
    [onOpenChange]
  )

  const submit = useCallback((): void => {
    const trimmed = prompt.trim()
    if (!trimmed) {
      return
    }
    onSubmit(trimmed)
    close(false)
  }, [prompt, onSubmit, close])

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.pet.PetAskDialog.title', 'Ask {{value0}}', {
              value0: agentLabel
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.pet.PetAskDialog.description',
              'Sends a prompt to the session the pet is watching.'
            )}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={translate(
            'auto.components.pet.PetAskDialog.placeholder',
            'Ask the agent something…'
          )}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            {translate('auto.components.pet.PetAskDialog.cancel', 'Cancel')}
          </Button>
          <Button onClick={submit} disabled={prompt.trim().length === 0}>
            {translate('auto.components.pet.PetAskDialog.send', 'Send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default PetAskDialog
