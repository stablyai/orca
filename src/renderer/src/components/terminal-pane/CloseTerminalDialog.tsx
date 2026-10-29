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
import { translate } from '@/i18n/i18n'

export type CloseTerminalDialogCopyKind = 'command' | 'agent' | 'chat-agent'

export default function CloseTerminalDialog({
  open,
  copyKind = 'command',
  tabLabel,
  subjectKey,
  onCancel,
  onConfirm
}: {
  open: boolean
  copyKind?: CloseTerminalDialogCopyKind
  /** Name off-focus tab-strip/middle-click targets; omit for focused-pane keyboard closes. */
  tabLabel?: string
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

  const trimmedTabLabel = tabLabel?.trim()

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
          trimmedTabLabel={trimmedTabLabel}
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
  trimmedTabLabel,
  checkboxId,
  dontAskAgain,
  setDontAskAgain,
  onCancel,
  onConfirm
}: {
  copyKind: CloseTerminalDialogCopyKind
  trimmedTabLabel: string | undefined
  checkboxId: string
  dontAskAgain: boolean
  setDontAskAgain: (value: boolean) => void
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
  const isAgent = copyKind !== 'command'
  const isChat = copyKind === 'chat-agent'
  return (
    <>
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
          {isChat
            ? translate(
                'auto.components.terminal.pane.CloseTerminalDialog.stop_chat_description',
                "Closing this chat will stop the agent's current work."
              )
            : isAgent
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
      {copyKind === 'agent' ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.terminal.pane.CloseTerminalDialog.automatic_resume_warning',
            'This terminal will not resume automatically. Cancel and put the workspace to sleep to resume it later.'
          )}
        </p>
      ) : null}
      {trimmedTabLabel ? (
        <p className="truncate text-xs font-medium text-foreground" title={trimmedTabLabel}>
          {trimmedTabLabel}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Checkbox
          id={checkboxId}
          checked={dontAskAgain}
          onCheckedChange={(checked) => setDontAskAgain(checked === true)}
        />
        <Label htmlFor={checkboxId} className="text-xs font-normal text-muted-foreground">
          {isChat
            ? translate('auto.components.confirmation.dialog.92bac3217e', "Don't ask again")
            : translate(
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
    </>
  )
}
