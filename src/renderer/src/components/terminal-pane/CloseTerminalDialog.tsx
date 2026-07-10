import { useEffect, useId, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

export type CloseTerminalDialogCopyKind = 'command' | 'agent'

export default function CloseTerminalDialog({
  open,
  copyKind = 'command',
  onCancel,
  onConfirm
}: {
  open: boolean
  copyKind?: CloseTerminalDialogCopyKind
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
  const checkboxId = useId()
  const [dontAskAgain, setDontAskAgain] = useState(false)

  useEffect(() => {
    if (open) {
      setDontAskAgain(false)
    }
  }, [open])

  const isAgent = copyKind === 'agent'

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onCancel()
        }
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {isAgent
              ? translate(
                  'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_title',
                  'Stop this agent?'
                )
              : translate(
                  'auto.components.terminal.pane.CloseTerminalDialog.stop_command_title',
                  'Stop running command?'
                )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {isAgent
              ? translate(
                  'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_description',
                  "Closing this terminal will stop the agent's current work."
                )
              : translate(
                  'auto.components.terminal.pane.CloseTerminalDialog.stop_command_description',
                  'Closing this terminal will stop the command running inside it.'
                )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Checkbox
            id={checkboxId}
            checked={dontAskAgain}
            onCheckedChange={(checked) => setDontAskAgain(checked === true)}
          />
          <Label htmlFor={checkboxId} className="text-xs font-normal text-muted-foreground">
            {translate(
              'auto.components.terminal.pane.CloseTerminalDialog.dont_ask_again',
              "Don't ask again for running terminals"
            )}
          </Label>
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {translate('auto.components.terminal.pane.CloseTerminalDialog.1d1a7a9c1f', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            autoFocus
            onClick={() => onConfirm(dontAskAgain)}
          >
            {isAgent
              ? translate(
                  'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_confirm',
                  'Stop Agent'
                )
              : translate(
                  'auto.components.terminal.pane.CloseTerminalDialog.stop_command_confirm',
                  'Stop and Close'
                )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
