// A reopened pane the continue logic won't type into on its own (a late reopen whose session or
// activity can't be confirmed): one click sends `continue`, once per interrupted turn.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getPtyIdForPaneKey } from '@/hooks/pane-key-pty-id'
import { sendBracketedPasteToRunningAgent } from '@/lib/agent-session/messaging/paste/agent-paste-draft'
import { INTERRUPTED_TURN_CONTINUE_PROMPT } from '../../../../../shared/agent-launch/startup/tui-agent-resume-startup'
import {
  isInterruptedTurnContinued,
  markInterruptedTurnContinued
} from '@/components/terminal-pane/pty-connection/startup/cold-restore-resume-startup'

export function offerInterruptedTurnContinue(paneKey: string, turnKey: string): void {
  toast(translate('orcaCloud.continueOffer.title', 'An agent was interrupted by the restart'), {
    id: `orca-continue-offer-${turnKey}`,
    duration: 60_000,
    action: {
      label: translate('orcaCloud.continueOffer.action', 'Continue'),
      onClick: () => {
        const ptyId = getPtyIdForPaneKey(paneKey)
        if (!ptyId || isInterruptedTurnContinued(turnKey)) {
          return
        }
        void sendBracketedPasteToRunningAgent({
          ptyId,
          content: INTERRUPTED_TURN_CONTINUE_PROMPT
        }).then((sent) => {
          if (sent) {
            markInterruptedTurnContinued(turnKey)
          }
        })
      }
    }
  })
}
