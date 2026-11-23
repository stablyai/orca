import { z } from 'zod'
import type { Translate } from '@/i18n/use-translate'
import { normalizeToolInput } from '../../../../../shared/native-chat/tools/native-chat-tool-summary'
import type { AgentJournalApprovalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  ORCHESTRATION_APPROVAL_CALLER_PREFIX,
  ORCHESTRATION_COORDINATOR_APPROVAL_CALLER_PREFIX,
  ORCHESTRATION_PERSON_APPROVAL_CALLER_PREFIX
} from '../../../../../shared/orchestration/approvals/worker-approval-payload'

/** Which shield the line shows: an answer either way, or a prompt that closed with none. */
export type NativeChatApprovalRecordTone = 'allowed' | 'denied' | 'open' | 'closed'

/** An answered permission prompt as one quiet line: `sentence` is translated and holds the tool as
 *  `<tool>{{tool}}</tool>` and a worker's task as `<task>{{task}}</task>`, so a translation places
 *  them where its grammar wants. `opensWorker`: the line ends with an Open worker link. */
export type NativeChatApprovalRecordLine = {
  tone: NativeChatApprovalRecordTone
  sentence: string
  values: { tool: string; task?: string; answer?: string }
  detail: string | null
  reason?: { label: string; text: string }
  at: number | null
  opensWorker?: true
}

/** The tool's own name when the provider gave one; otherwise the prompt's title as it read. */
export function approvalRecordTool(toolName: string | undefined, title: string): string {
  return toolName?.trim() || title
}

// A tool call's input as the agent wrote it: its shell command, when it has one.
const ToolCommandInput = z.object({ command: z.string().optional(), cmd: z.string().optional() })

/** A tool call's input reads as its command, as the agent's own tool rows show it; any other
 *  detail as it is. */
export function approvalRecordDetail(detail: string | null): string | null {
  const parsed = ToolCommandInput.safeParse(detail === null ? null : normalizeToolInput(detail))
  const command = parsed.success ? (parsed.data.command ?? parsed.data.cmd) : undefined
  return command?.trim() ? command : detail
}

/** The chat's own prompt, answered here, on another device, or by its coordinator through Orca. */
export function ownApprovalRecordLine(
  body: AgentJournalApprovalItem,
  t: Translate
): NativeChatApprovalRecordLine {
  const { resolution } = body
  const tool = approvalRecordTool(body.toolName, body.displayName ?? body.title)
  const base = { detail: approvalRecordDetail(body.detail), at: resolution.resolvedAt }
  if (resolution.state !== 'resolved') {
    return {
      ...base,
      tone: 'closed',
      sentence: t(
        'components.native-chat.approval.record.cancelled',
        'Request for <tool>{{tool}}</tool> cancelled'
      ),
      values: { tool }
    }
  }
  const option = body.options.find((entry) => entry.id === resolution.selectedOptionId)
  const resolvedBy = resolution.resolvedBy ?? ''
  // Orca answers a worker's prompt only by allowing or refusing this one call.
  const allows = option?.intent === 'allow_once'
  if (allows || option?.intent === 'reject_once') {
    if (resolvedBy.startsWith(ORCHESTRATION_COORDINATOR_APPROVAL_CALLER_PREFIX)) {
      return {
        ...base,
        tone: allows ? 'allowed' : 'denied',
        sentence: allows
          ? t(
              'components.native-chat.approval.record.coordinatorAllowedHere',
              'Coordinator allowed <tool>{{tool}}</tool>'
            )
          : t(
              'components.native-chat.approval.record.coordinatorDeniedHere',
              'Coordinator denied <tool>{{tool}}</tool>'
            ),
        values: { tool }
      }
    }
    // Older builds named no one: the coordinator or a person in its chat.
    if (
      resolvedBy.startsWith(ORCHESTRATION_APPROVAL_CALLER_PREFIX) &&
      !resolvedBy.startsWith(ORCHESTRATION_PERSON_APPROVAL_CALLER_PREFIX)
    ) {
      return {
        ...base,
        tone: allows ? 'allowed' : 'denied',
        sentence: allows
          ? t(
              'components.native-chat.approval.record.allowedUnnamed',
              'Allowed <tool>{{tool}}</tool>'
            )
          : t(
              'components.native-chat.approval.record.deniedUnnamed',
              'Denied <tool>{{tool}}</tool>'
            ),
        values: { tool }
      }
    }
  }
  switch (option?.intent) {
    case 'allow_once':
      return {
        ...base,
        tone: 'allowed',
        sentence: t(
          'components.native-chat.approval.record.youAllowed',
          'You allowed <tool>{{tool}}</tool>'
        ),
        values: { tool }
      }
    case 'allow_always':
      return {
        ...base,
        tone: 'allowed',
        sentence: t(
          'components.native-chat.approval.record.youAllowedForSession',
          'You allowed <tool>{{tool}}</tool> for this session'
        ),
        values: { tool }
      }
    case 'reject_once':
    case 'reject_always':
      return {
        ...base,
        tone: 'denied',
        sentence: t(
          'components.native-chat.approval.record.youDenied',
          'You denied <tool>{{tool}}</tool>'
        ),
        values: { tool }
      }
    case undefined:
      // An option that neither grants nor refuses (a stop), or one this build cannot read.
      return {
        ...base,
        tone: 'closed',
        sentence: t(
          'components.native-chat.approval.record.youAnswered',
          'You answered <tool>{{tool}}</tool>: {{answer}}'
        ),
        values: {
          tool,
          answer:
            option?.label ??
            t('components.native-chat.receipt.unavailable', 'Selected answer unavailable')
        }
      }
  }
}
