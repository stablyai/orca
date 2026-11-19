import type { AutomationRunMessage } from '../../../../../shared/automations/automation-run-message'
import { automationRunInstructions } from '../../../../../shared/automations/automation-run-message'
import {
  automationRunFacts,
  automationRunLabel,
  type AutomationRunResend,
  type AutomationRunRowState
} from '../../../../../shared/automations/automation-run-row-words'
import { automationRunMark } from '../../../../../shared/automations/automation-chat-row'
import { useNativeChatDisclosure } from '../messages/disclosure/native-chat-disclosure-store'
import { useNativeChatFindQuery } from '../viewport/find/native-chat-find-query'
import { useAutomationRunWording } from './automation-run-wording'
import {
  NativeChatAutomationRunBody,
  NativeChatAutomationSendAgain
} from './NativeChatAutomationRunBody'
import { NativeChatAutomationRowFrame } from './NativeChatAutomationRowFrame'

export type NativeChatAutomationRunRowProps = {
  messageId: string
  run: AutomationRunMessage
  state: AutomationRunRowState
  /** What was sent, or would have been: the saved prompt, then Orca's record of the event. */
  text: string
  timestamp: number | null
  /** A run that couldn't start: the send's own error. */
  error?: string
  /** Whether Send again is offered here, or already went. */
  resend?: AutomationRunResend
  onRefolded: () => void
}

/** An automation's run as a status row: "<trigger> · <name>", or "Couldn't start <name>" with Send
 *  again. Opens to its error, instructions and the event; never the owner's message. */
export function NativeChatAutomationRunRow({
  messageId,
  run,
  state,
  text,
  timestamp,
  error,
  resend = 'none',
  onRefolded
}: NativeChatAutomationRunRowProps): React.JSX.Element {
  const wording = useAutomationRunWording(run.automation)
  const { say } = wording
  const disclosure = useNativeChatDisclosure(`automation-run:${messageId}`, false)
  const findQuery = useNativeChatFindQuery()
  const instructions = automationRunInstructions(text, run)
  const facts = automationRunFacts(run, timestamp, wording)
  const notStarted = state === 'not-started'
  return (
    <NativeChatAutomationRowFrame
      mark={automationRunMark(run)}
      lead={notStarted ? say('couldNotStart') : automationRunLabel(run, say)}
      leadIsVerb={notStarted}
      name={run.automation.name}
      status={state === 'queued' ? say('queued') : null}
      failed={notStarted}
      timestamp={timestamp}
      open={disclosure.open}
      onToggle={() => {
        disclosure.setOpen(!disclosure.open)
        if (disclosure.open) {
          requestAnimationFrame(onRefolded)
        }
      }}
      action={
        notStarted ? (
          <NativeChatAutomationSendAgain run={run} resend={resend} wording={wording} />
        ) : null
      }
      // The instructions cut themselves, under their own Show all.
      clampDetails={false}
    >
      <NativeChatAutomationRunBody
        messageId={messageId}
        run={run}
        state={state}
        instructions={instructions}
        facts={facts}
        error={error}
        wording={wording}
        findQuery={findQuery}
      />
    </NativeChatAutomationRowFrame>
  )
}
