import { useState } from 'react'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import type { AutomationRunMessage } from '../../../../../shared/automations/automation-run-message'
import { automationRunInstructions } from '../../../../../shared/automations/automation-run-message'
import {
  automationRunAccessibleName,
  automationRunFacts,
  automationRunLabel,
  automationRunReason,
  type AutomationRunResend,
  type AutomationRunRowState
} from '../../../../../shared/automations/automation-run-row-words'
import { automationRunMark } from '../../../../../shared/automations/automation-chat-row'
import { NativeChatCopyButton } from '../messages/actions/NativeChatCopyButton'
import { useNativeChatDisclosure } from '../messages/disclosure/native-chat-disclosure-store'
import { nativeChatFindHits, useNativeChatFindQuery } from '../viewport/find/native-chat-find-query'
import { useAutomationRunWording } from './automation-run-wording'
import { NativeChatAutomationRunBody } from './NativeChatAutomationRunBody'
import { NativeChatAutomationRowFrame } from './NativeChatAutomationRowFrame'

// The copy button shows on hover or keyboard focus, as on the coordinator's row.
const REVEAL =
  'relative transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 [.group:has(:focus-visible)_&]:pointer-events-auto [.group:has(:focus-visible)_&]:opacity-100'

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

/** A bot automation's run, on the coordinator row's frame: what fired, its name, why it ran and
 *  when. Opens to its instructions and the event; never the owner's message. */
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
  // A row the reader folds while finding stays folded for that query.
  const [foldedFor, setFoldedFor] = useState<string | null>(null)
  const label = automationRunLabel(run, say)
  const reason = automationRunReason(run, state, timestamp, wording)
  const instructions = automationRunInstructions(text, run)
  const facts = automationRunFacts(run, timestamp, wording)
  const found = nativeChatFindHits(
    [label, run.automation.name, reason, instructions, facts, run.event?.text, error]
      .filter(Boolean)
      .join('\n'),
    findQuery
  )
  const open = disclosure.open || (found && foldedFor !== findQuery)
  const fullTime =
    timestamp === null
      ? null
      : uiDateTimeFormat({
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        }).format(timestamp)
  const toggle = (): void => {
    if (open && found) {
      setFoldedFor(findQuery)
    }
    disclosure.setOpen(!open)
    if (open) {
      requestAnimationFrame(onRefolded)
    }
  }
  return (
    <NativeChatAutomationRowFrame
      mark={automationRunMark(run)}
      label={label}
      name={run.automation.name}
      status={reason}
      failed={state === 'not-started'}
      accessibleName={automationRunAccessibleName(
        { label, name: run.automation.name, reason, time: fullTime },
        say
      )}
      timestamp={timestamp}
      open={open}
      onToggle={toggle}
      runId={run.runId}
      action={
        instructions ? (
          <NativeChatCopyButton
            text={instructions}
            label={say('copyInstructions')}
            className={REVEAL}
          />
        ) : null
      }
    >
      {({ bodyId, toggleId }) => (
        <NativeChatAutomationRunBody
          id={bodyId}
          labelledBy={toggleId}
          messageId={messageId}
          run={run}
          state={state}
          instructions={instructions}
          facts={facts}
          error={error}
          resend={resend}
          timestamp={timestamp}
          wording={wording}
          findQuery={found ? findQuery : ''}
        />
      )}
    </NativeChatAutomationRowFrame>
  )
}
