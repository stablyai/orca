import type { NativeChatMessage } from '../native-chat/native-chat-types'
import { agentMessageDisplayText } from './agent-message-display-text'
import {
  agentMessageSourceAddressLabel,
  senderHasOrchestrationProvenance
} from './agent-message-presentation'
import type { AgentMessageSender } from './agent-session-message-source'
import {
  mailDisplayAttachmentKey,
  readMailDisplayReport,
  type MailDisplayReport
} from './mail-display-report'

export { senderHasOrchestrationProvenance } from './agent-message-presentation'

export function mailReportSourceLabel(
  senders: readonly AgentMessageSender[],
  terminalFallback?: string
): string {
  return (
    senders
      .map((sender) => sender.name || agentMessageSourceAddressLabel(sender, terminalFallback))
      .join(', ') || '—'
  )
}

export type MailReportPresentation = {
  kind: 'command-report' | 'external-report' | 'aggregate-report'
  source: string
  text: string
  report?: MailDisplayReport
}

/** Classify the event's provenance, independently of its sender's display name or prose. */
export function mailReportPresentation(
  message: Pick<
    NativeChatMessage,
    'from' | 'agentStart' | 'agentHandoff' | 'blocks' | 'mailDisplayReports' | 'shortened'
  >
): MailReportPresentation | undefined {
  const from = message.from
  if (
    !from ||
    message.agentStart ||
    message.agentHandoff ||
    from.orchestration?.message !== 'mail-notice'
  ) {
    return
  }
  const mail = from.orchestration
  const reports = new Map(
    message.mailDisplayReports?.map((fact) => [mailDisplayAttachmentKey(fact), fact.report])
  )
  const actors = new Set(
    from.senders.filter(senderHasOrchestrationProvenance).map((sender) => sender.party.address)
  )
  const classifications = mail.messages.map((entry) => {
    const report = readMailDisplayReport(
      reports.get(mailDisplayAttachmentKey({ ...entry, mailbox: mail.mailbox }))
    )
    return { report, orchestration: !report && actors.has(entry.from) }
  })
  if (!classifications.length || classifications.every((entry) => entry.orchestration)) {
    return
  }
  const single = classifications.length === 1
  const displayText = single
    ? agentMessageDisplayText(message.blocks, from, message.shortened)
    : undefined
  const invalidRange =
    single && mail.messages[0]?.content !== undefined && displayText === undefined
  const report = single && !invalidRange ? classifications[0]?.report : undefined
  const source = mailReportSourceLabel(from.senders)
  return {
    kind:
      single && !invalidRange
        ? report
          ? 'command-report'
          : 'external-report'
        : 'aggregate-report',
    source,
    text: single
      ? (displayText ??
        message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'))
      : message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n'),
    ...(report ? { report } : {})
  }
}
