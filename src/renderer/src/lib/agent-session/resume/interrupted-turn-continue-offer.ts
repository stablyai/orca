// Helpers for the interrupted-turn continue. A reopened pane the continue logic won't type into on its own (a late reopen whose session or
// activity can't be confirmed): one click sends `continue`, once per interrupted turn.
import { toast } from 'sonner'
import { inspectRuntimeTerminalProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { TUI_AGENT_CONFIG } from '../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess
} from '../../../../../shared/agent-status/process/agent-process-recognition'
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

/** The relaunched agent (not a shell) is the terminal's foreground process. */
export async function agentOwnsTerminal(ptyId: string, agent: TuiAgent): Promise<boolean> {
  try {
    const foreground = (await inspectRuntimeTerminalProcess(ptyId)).foregroundProcess ?? ''
    return (
      isExpectedAgentProcess(foreground, TUI_AGENT_CONFIG[agent].expectedProcess) ||
      isAgentForegroundWrapperProcess(foreground)
    )
  } catch {
    return false
  }
}
