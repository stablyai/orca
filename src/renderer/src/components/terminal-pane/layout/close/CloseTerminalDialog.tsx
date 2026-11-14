import { useId, useState } from 'react'
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
import { useTranslate } from '@/i18n/use-translate'

export type CloseTerminalDialogCopyKind = 'command' | 'agent' | 'chat-agent'

export default function CloseTerminalDialog({
  open,
  copyKind = 'command',
  subjectKey,
  onCancel,
  onConfirm
}: {
  open: boolean
  copyKind?: CloseTerminalDialogCopyKind
  /** Changing queued subject clears the previous tab’s opt-out without reopening the dialog. */
  subjectKey?: string
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
  const checkboxId = useId()
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [previousOpen, setPreviousOpen] = useState(open)
  const [previousSubjectKey, setPreviousSubjectKey] = useState(subjectKey)

  // Reset each new confirmation before paint to avoid flashing the previous opt-out.
  if (open !== previousOpen) {
    setPreviousOpen(open)
    if (open) {
      setDontAskAgain(false)
    }
  }

  // Queued subjects change without reopening; ignore closing-to-undefined so the checkbox cannot flash during exit.
  if (subjectKey !== previousSubjectKey) {
    setPreviousSubjectKey(subjectKey)
    if (subjectKey !== undefined) {
      setDontAskAgain(false)
    }
  }

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
        <CloseTerminalDialogBody
          copyKind={copyKind}
          checkboxId={checkboxId}
          dontAskAgain={dontAskAgain}
          setDontAskAgain={setDontAskAgain}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      </DialogContent>
    </Dialog>
  )
}

// Keep translation and element construction behind the dialog portal's mount boundary.
function CloseTerminalDialogBody({
  copyKind,
  checkboxId,
  dontAskAgain,
  setDontAskAgain,
  onCancel,
  onConfirm
}: {
  copyKind: CloseTerminalDialogCopyKind
  checkboxId: string
  dontAskAgain: boolean
  setDontAskAgain: (value: boolean) => void
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const isAgent = copyKind !== 'command'
  const isChat = copyKind === 'chat-agent'
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">
          {isAgent
            ? t(
                'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_title',
                'Stop this agent?'
              )
            : t(
                'auto.components.terminal.pane.CloseTerminalDialog.stop_command_title',
                'Stop running command?'
              )}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {isChat
            ? t(
                'auto.components.terminal.pane.CloseTerminalDialog.stop_chat_description',
                "Closing this chat will stop the agent's current work."
              )
            : isAgent
              ? t(
                  'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_description',
                  "Closing this terminal will stop the agent's current work."
                )
              : t(
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
          {isChat
            ? t('auto.components.confirmation.dialog.92bac3217e', "Don't ask again")
            : t(
                'auto.components.terminal.pane.CloseTerminalDialog.dont_ask_again',
                "Don't ask again for running terminals"
              )}
        </Label>
      </div>
      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t('auto.components.terminal.pane.CloseTerminalDialog.1d1a7a9c1f', 'Cancel')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          autoFocus
          onClick={() => onConfirm(dontAskAgain)}
        >
          {isAgent
            ? t(
                'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_confirm',
                'Stop Agent'
              )
            : t(
                'auto.components.terminal.pane.CloseTerminalDialog.stop_command_confirm',
                'Stop and Close'
              )}
        </Button>
      </DialogFooter>
    </>
  )
}
