import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

type Props = {
  open: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}

/** Confirms closing an agent session: the WHOLE terminal tab dies, split panes
 *  and any sibling agents included. */
export const CloseAgentSessionDialog = React.memo(function CloseAgentSessionDialog({
  open,
  onConfirm,
  onOpenChange
}: Props): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-sm">
              {translate(
                'auto.components.sidebar.WorktreeCardAgents.2ec931a922',
                'Close agent session?'
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'auto.components.sidebar.WorktreeCardAgents.e1250e23e9',
                'This closes the entire terminal tab running this agent, including all of its split panes. Any other agents running in those panes will be stopped too.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {translate('auto.components.sidebar.WorktreeCardAgents.7d17689ff0', 'Cancel')}
            </Button>
            <Button variant="destructive" onClick={onConfirm}>
              {translate('auto.components.sidebar.WorktreeCardAgents.6ac88e0ff9', 'Close session')}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  )
})
