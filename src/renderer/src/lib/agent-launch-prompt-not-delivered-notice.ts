import { toast } from 'sonner'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * The agent started but the host kept its prompt: the agent never showed it was ready for input,
 * or a dialog it opened was still up when the wait ran out. Nothing was typed into the pane, so the
 * user is handed the text to paste themselves.
 */
export function showAgentLaunchPromptNotDeliveredNotice(args: {
  agent: TuiAgent
  prompt: string
}): void {
  showPromptCopyNotice(
    translate(
      'auto.lib.agent.launch.prompt.not.delivered.notice.message',
      "The agent started, but your prompt wasn't sent. Copy it and paste it once the agent is ready."
    ),
    args.prompt
  )
  track('agent_error', {
    error_class: 'paste_readiness_timeout',
    agent_kind: tuiAgentToAgentKind(args.agent)
  })
}

/**
 * The agent started with the prompt on its command line, but nothing proved it received it: no hook
 * turn, and the host cannot tell what holds the terminal. Not a "wasn't sent", so the user is told
 * to check the agent before sending the prompt again.
 */
export function showAgentLaunchPromptUnconfirmedNotice(args: {
  agent: TuiAgent
  prompt: string
}): void {
  showPromptCopyNotice(
    translate(
      'auto.lib.agent.launch.prompt.unconfirmed.notice.message',
      "Orca couldn't confirm the agent received your prompt. Check the agent before sending it again."
    ),
    args.prompt
  )
  track('agent_error', {
    error_class: 'paste_readiness_timeout',
    agent_kind: tuiAgentToAgentKind(args.agent)
  })
}

/**
 * The agent had the prompt on its command line but exited at startup, before it read it. It did
 * not really start, so the user is handed the text to start it again with.
 */
export function showAgentLaunchExitedNotice(args: { agent: TuiAgent; prompt: string }): void {
  showPromptCopyNotice(
    translate(
      'auto.lib.agent.launch.prompt.exited.notice.message',
      'The agent exited at startup, before it received your prompt. Copy the prompt and start the agent again.'
    ),
    args.prompt
  )
  track('agent_error', { error_class: 'unknown', agent_kind: tuiAgentToAgentKind(args.agent) })
}

/**
 * The host refused to start the agent because it could not write the launch file that carries the
 * prompt. Nothing ran, so the user is handed the text to launch again with.
 */
export function showAgentLaunchNotStartedNotice(args: { prompt: string }): void {
  showPromptCopyNotice(
    translate(
      'auto.lib.agent.launch.prompt.not.started.notice.message',
      "The agent wasn't started: Orca couldn't write the file that carries your prompt. Copy the prompt and launch again."
    ),
    args.prompt
  )
}

function showPromptCopyNotice(message: string, prompt: string): void {
  toast.message(message, {
    // The action is the only copy of the prompt, so the notice stays until the user dismisses it.
    duration: Infinity,
    action: {
      label: translate('auto.lib.agent.launch.prompt.not.delivered.notice.copy', 'Copy prompt'),
      onClick: () => {
        void window.api.ui.writeClipboardText(prompt).catch((error: unknown) => {
          console.error('Could not copy the launch prompt', error)
        })
      }
    }
  })
}
