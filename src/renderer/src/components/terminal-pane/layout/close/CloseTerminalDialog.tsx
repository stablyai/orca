import { useId, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel } from '@/components/ui/dialog-parts'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { useModalReturnFocus } from '@/lib/pane-manager/pane-focus/useModalReturnFocus'

export type CloseTerminalDialogCopyKind = 'command' | 'agent' | 'chat-agent'

export default function CloseTerminalDialog({
  open,
  copyKind = 'command',
  subjectKey,
  workspaceName,
  onSleepInstead,
  onCancel,
  onConfirm
}: {
  open: boolean
  copyKind?: CloseTerminalDialogCopyKind
  /** Names the workspace in a terminal agent's title. */
  workspaceName?: string
  /** Offered only where sleeping keeps the agent's session resumable. */
  onSleepInstead?: () => void
  /** Changing queued subject clears the previous tab’s opt-out without reopening the dialog. */
  subjectKey?: string
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
  const checkboxId = useId()
  // Why: no Radix trigger, so dismiss would leave focus on body; Stop/Sleep move focus themselves, and Cancel re-arms after a queued Stop.
  const { captureReturnFocus, skipReturnFocus, rearmReturnFocus } = useModalReturnFocus(open, {
    preferCapturedElement: true
  })
  const cancel = (): void => {
    rearmReturnFocus()
    onCancel()
  }
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
          cancel()
        }
      }}
    >
      <DialogContent size="confirm" initialFocus="cancel" onOpenAutoFocus={captureReturnFocus}>
        <CloseTerminalDialogBody
          copyKind={copyKind}
          workspaceName={workspaceName}
          onSleepInstead={
            onSleepInstead
              ? () => {
                  skipReturnFocus()
                  onSleepInstead()
                }
              : undefined
          }
          checkboxId={checkboxId}
          dontAskAgain={dontAskAgain}
          setDontAskAgain={setDontAskAgain}
          onCancel={cancel}
          onConfirm={(dontAskAgainChoice) => {
            skipReturnFocus()
            onConfirm(dontAskAgainChoice)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

// Keep translation and element construction behind the dialog portal's mount boundary.
function CloseTerminalDialogBody({
  copyKind,
  workspaceName,
  onSleepInstead,
  checkboxId,
  dontAskAgain,
  setDontAskAgain,
  onCancel,
  onConfirm
}: {
  copyKind: CloseTerminalDialogCopyKind
  workspaceName?: string
  onSleepInstead?: () => void
  checkboxId: string
  dontAskAgain: boolean
  setDontAskAgain: (value: boolean) => void
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const isAgent = copyKind !== 'command'
  const title =
    copyKind === 'chat-agent'
      ? t(
          'components.terminal.pane.CloseTerminalDialog.stopChatAgentTitle',
          'Stop the agent in this chat?'
        )
      : copyKind === 'agent'
        ? workspaceName
          ? t(
              'components.terminal.pane.CloseTerminalDialog.stopAgentInWorkspaceTitle',
              'Stop the agent in “{{name}}”?',
              { name: workspaceName }
            )
          : t(
              'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_title',
              'Stop this agent?'
            )
        : t(
            'components.terminal.pane.CloseTerminalDialog.stopRunningCommandTitle',
            'Stop the running command?'
          )
  const optOut = (
    <div className="flex items-center gap-2">
      <Checkbox
        id={checkboxId}
        checked={dontAskAgain}
        onCheckedChange={(checked) => setDontAskAgain(checked === true)}
      />
      <Label htmlFor={checkboxId} variant="dialog-muted">
        {t('auto.components.confirmation.dialog.92bac3217e', "Don't ask again")}
      </Label>
    </div>
  )
  return (
    <>
      <DialogHeader>
        <DialogTitle className="break-words">{title}</DialogTitle>
        {isAgent ? (
          <DialogDescription>
            {t(
              'components.terminal.pane.CloseTerminalDialog.agentWorkStops',
              'Its current work stops and won’t resume.'
            )}
          </DialogDescription>
        ) : null}
      </DialogHeader>
      {onSleepInstead ? optOut : null}
      <DialogFooter
        start={
          onSleepInstead ? (
            <Button type="button" variant="ghost" size="sm" onClick={onSleepInstead}>
              {t(
                'components.terminal.pane.CloseTerminalDialog.sleepWorkspaceInstead',
                'Sleep workspace'
              )}
            </Button>
          ) : (
            optOut
          )
        }
      >
        <DialogCancel
          onClick={(event) => {
            event.preventDefault()
            onCancel()
          }}
        >
          {t('auto.components.terminal.pane.CloseTerminalDialog.1d1a7a9c1f', 'Cancel')}
        </DialogCancel>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => onConfirm(dontAskAgain)}
        >
          {isAgent
            ? t('components.terminal.pane.CloseTerminalDialog.stopAgentSentence', 'Stop agent')
            : t('components.terminal.pane.CloseTerminalDialog.stopAndClose', 'Stop and close')}
        </Button>
      </DialogFooter>
    </>
  )
}
