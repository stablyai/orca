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
import { useAppStore } from '@/store'
import { isTerminalPaneCloseChord } from './terminal-shortcut-policy'

export type CloseTerminalDialogCopyKind = 'command' | 'agent'

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
  /** Names the tab when the prompt can target a tab the user is not looking at
   *  (tab-strip X, middle-click). Omitted for the focused-pane keyboard path. */
  tabLabel?: string
  /** Identifies what is being closed, for hosts that reuse one open dialog across a queue
   *  of confirmations. Changing it clears the previous subject's "don't ask again" tick. */
  subjectKey?: string
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
  const checkboxId = useId()
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [previousOpen, setPreviousOpen] = useState(open)
  const [previousSubjectKey, setPreviousSubjectKey] = useState(subjectKey)
  const keybindings = useAppStore((state) => state.keybindings)

  // Why: a second close chord while the prompt is open means "I'm sure" (#21603).
  // Confirm with the live opt-out tick so checkbox-then-Cmd+W still persists it. The
  // opening chord can't reach this listener (the dialog mounts after its probe) and
  // repeats are ignored, so a held key can't skip the prompt.
  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.defaultPrevented) {
        return
      }
      const platform: NodeJS.Platform = navigator.userAgent.includes('Mac')
        ? 'darwin'
        : navigator.userAgent.includes('Windows')
          ? 'win32'
          : 'linux'
      if (!isTerminalPaneCloseChord(event, platform, keybindings)) {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      onConfirm(dontAskAgain)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [open, dontAskAgain, onConfirm, keybindings])

  // Why: each reopen represents a fresh confirmation, so clear the old choice
  // during render rather than briefly painting it while the dialog opens.
  if (open !== previousOpen) {
    setPreviousOpen(open)
    if (open) {
      setDontAskAgain(false)
    }
  }

  // Why: a queued confirmation swaps the subject without ever closing the dialog, so the
  // reopen reset above never fires. Ignore the swap to undefined as the dialog closes —
  // clearing the tick mid-exit-animation would be visible for no reason.
  if (subjectKey !== previousSubjectKey) {
    setPreviousSubjectKey(subjectKey)
    if (subjectKey !== undefined) {
      setDontAskAgain(false)
    }
  }

  const isAgent = copyKind === 'agent'
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
      <DialogContent className="max-w-sm" showCloseButton={false} data-close-terminal-dialog="true">
        <CloseTerminalDialogBody
          isAgent={isAgent}
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
  isAgent,
  trimmedTabLabel,
  checkboxId,
  dontAskAgain,
  setDontAskAgain,
  onCancel,
  onConfirm
}: {
  isAgent: boolean
  trimmedTabLabel: string | undefined
  checkboxId: string
  dontAskAgain: boolean
  setDontAskAgain: (value: boolean) => void
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
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
      {isAgent ? (
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
    </>
  )
}
