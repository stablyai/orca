import { z } from 'zod'
import type { Translate } from '@/i18n/use-translate'
import { normalizeToolInput } from '../../../../../shared/native-chat/tools/native-chat-tool-summary'
import { ownApprovalRecord } from '../../../../../shared/agent-session/requests/prompts/agent-session-approval-record'
import type { AgentJournalApprovalItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

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
  const record = ownApprovalRecord(body)
  const { tool } = record
  const line = {
    tone: record.tone,
    detail: approvalRecordDetail(body.detail),
    at: body.resolution.resolvedAt
  }
  switch (record.sentence) {
    case 'cancelled':
      return {
        ...line,
        sentence: t(
          'components.native-chat.approval.record.cancelled',
          'Request for <tool>{{tool}}</tool> cancelled'
        ),
        values: { tool }
      }
    case 'coordinatorAllowed':
      return {
        ...line,
        sentence: t(
          'components.native-chat.approval.record.coordinatorAllowedHere',
          'Coordinator allowed <tool>{{tool}}</tool>'
        ),
        values: { tool }
      }
    case 'coordinatorDenied':
      return {
        ...line,
        sentence: t(
          'components.native-chat.approval.record.coordinatorDeniedHere',
          'Coordinator denied <tool>{{tool}}</tool>'
        ),
        values: { tool }
      }
    case 'allowedUnnamed':
      return {
        ...line,
        sentence: t(
          'components.native-chat.approval.record.allowedUnnamed',
          'Allowed <tool>{{tool}}</tool>'
        ),
        values: { tool }
      }
    case 'deniedUnnamed':
      return {
        ...line,
        sentence: t(
          'components.native-chat.approval.record.deniedUnnamed',
          'Denied <tool>{{tool}}</tool>'
        ),
        values: { tool }
      }
    case 'youAllowed':
      return {
        ...line,
        sentence: t(
          'components.native-chat.approval.record.youAllowed',
          'You allowed <tool>{{tool}}</tool>'
        ),
        values: { tool }
      }
    case 'youAllowedForSession':
      return {
        ...line,
        sentence: t(
          'components.native-chat.approval.record.youAllowedForSession',
          'You allowed <tool>{{tool}}</tool> for this session'
        ),
        values: { tool }
      }
    case 'youDenied':
      return {
        ...line,
        sentence: t(
          'components.native-chat.approval.record.youDenied',
          'You denied <tool>{{tool}}</tool>'
        ),
        values: { tool }
      }
    case 'youAnswered':
      return {
        ...line,
        sentence: t(
          'components.native-chat.approval.record.youAnswered',
          'You answered <tool>{{tool}}</tool>: {{answer}}'
        ),
        values: {
          tool,
          answer:
            record.answer ??
            t('components.native-chat.receipt.unavailable', 'Selected answer unavailable')
        }
      }
  }
}
