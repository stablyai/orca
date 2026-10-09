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
import { CloseTerminalGroupList } from './CloseTerminalGroupList'

export type CloseTerminalDialogCopyKind = 'command' | 'agent'

export type CloseTerminalDialogTerminal = {
  key: string
  label: string
  copyKind: CloseTerminalDialogCopyKind
}

export default function CloseTerminalDialog({
  open,
  copyKind = 'command',
  tabLabel,
  subjectKey,
  terminals,
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
  terminals?: CloseTerminalDialogTerminal[]
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
  const checkboxId = useId()
  const [dontAskAgain, setDontAskAgain] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [previousOpen, setPreviousOpen] = useState(open)
  const [previousSubjectKey, setPreviousSubjectKey] = useState(subjectKey)

  // Why: each reopen represents a fresh confirmation, so clear the old choice
  // during render rather than briefly painting it while the dialog opens.
  if (open !== previousOpen) {
    setPreviousOpen(open)
    if (open) {
      setDontAskAgain(false)
      setExpanded(false)
    }
  }

  // Why: a queued confirmation swaps the subject without ever closing the dialog, so the
  // reopen reset above never fires. Ignore the swap to undefined as the dialog closes —
  // clearing the tick mid-exit-animation would be visible for no reason.
  if (subjectKey !== previousSubjectKey) {
    setPreviousSubjectKey(subjectKey)
    if (subjectKey !== undefined) {
      setDontAskAgain(false)
      setExpanded(false)
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
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <CloseTerminalDialogBody
          isAgent={isAgent}
          trimmedTabLabel={trimmedTabLabel}
          terminals={terminals}
          expanded={expanded}
          setExpanded={setExpanded}
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
  terminals,
  expanded,
  setExpanded,
  checkboxId,
  dontAskAgain,
  setDontAskAgain,
  onCancel,
  onConfirm
}: {
  isAgent: boolean
  trimmedTabLabel: string | undefined
  terminals: CloseTerminalDialogTerminal[] | undefined
  expanded: boolean
  setExpanded: (value: boolean) => void
  checkboxId: string
  dontAskAgain: boolean
  setDontAskAgain: (value: boolean) => void
  onCancel: () => void
  onConfirm: (dontAskAgain: boolean) => void
}): React.JSX.Element {
  const displayedTabLabel = terminals
    ? trimmedTabLabel || translate('components.tabCluster.unnamed', 'Unnamed group')
    : trimmedTabLabel

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-sm">
          {isAgent
            ? terminals
              ? translate(
                  'auto.components.terminal.pane.CloseTerminalDialog.stop_agents_title',
                  'Stop these agents?'
                )
              : translate(
                  'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_title',
                  'Stop this agent?'
                )
            : terminals
              ? translate(
                  'auto.components.terminal.pane.CloseTerminalDialog.stop_commands_title',
                  'Stop running commands?'
                )
              : translate(
                  'auto.components.terminal.pane.CloseTerminalDialog.stop_command_title',
                  'Stop running command?'
                )}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {terminals
            ? translate(
                'auto.components.terminal.pane.CloseTerminalDialog.stop_group_description',
                'Closing this group will stop {{count}} running terminals.',
                {
                  count: terminals.length,
                  defaultValue_one: 'Closing this group will stop {{count}} running terminal.'
                }
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
      {isAgent ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.terminal.pane.CloseTerminalDialog.automatic_resume_warning',
            'This terminal will not resume automatically. Cancel and put the workspace to sleep to resume it later.'
          )}
        </p>
      ) : null}
      {displayedTabLabel ? (
        <p className="truncate text-xs font-medium text-foreground" title={displayedTabLabel}>
          {displayedTabLabel}
        </p>
      ) : null}
      {terminals ? (
        <CloseTerminalGroupList
          terminals={terminals}
          expanded={expanded}
          onExpandedChange={setExpanded}
        />
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
