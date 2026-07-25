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
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'

type AgentStopConfirmDialogProps = {
  /** The agent awaiting confirmation; null renders the dialog closed. */
  card: DashboardCard | null
  onCancel: () => void
  onConfirm: (card: DashboardCard) => void
}

/**
 * Confirms stopping an agent that is still running. Reuses CloseTerminalDialog's
 * copy keys verbatim so the board and Cmd+W say the same thing about the same
 * action. The "don't ask again" opt-out is deliberately omitted: it belongs to
 * the terminal's own close flow, not to a board that stops agents by the card.
 */
export function AgentStopConfirmDialog({
  card,
  onCancel,
  onConfirm
}: AgentStopConfirmDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={card !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          onCancel()
        }
      }}
    >
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_title',
              'Stop this agent?'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_description',
              "Closing this terminal will stop the agent's current work."
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {translate('auto.components.terminal.pane.CloseTerminalDialog.1d1a7a9c1f', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            autoFocus
            onClick={() => {
              if (card) {
                onConfirm(card)
              }
            }}
          >
            {translate(
              'auto.components.terminal.pane.CloseTerminalDialog.stop_agent_confirm',
              'Stop Agent'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
