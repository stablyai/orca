import { z } from 'zod'
import { readAgentMessageSource, type AgentMessageSender } from './agent-session-message-source'
import type { AgentJournalRenderItem } from './journal/agent-session-journal-types'

const commandReport = z.object({
  version: z.literal(1),
  kind: z.literal('command'),
  result: z
    .discriminatedUnion('type', [
      z.object({
        type: z.literal('exit'),
        code: z.number().int().min(-2147483648).max(2147483647)
      }),
      z.object({ type: z.literal('signal'), signal: z.string().min(1).max(64) })
    ])
    .optional()
})

export type MailDisplayReport = z.infer<typeof commandReport>

/** Display declarations never refuse the canonical mail they accompany. */
export function readMailDisplayReport(value: unknown): MailDisplayReport | undefined {
  try {
    const decoded: unknown = typeof value === 'string' ? JSON.parse(value) : value
    const parsed = commandReport.safeParse(decoded)
    if (!parsed.success || new TextEncoder().encode(JSON.stringify(decoded)).length > 1024) {
      return
    }
    return parsed.data
  } catch {
    return undefined
  }
}

export function readAnswerSenderSnapshot(value: unknown): AgentMessageSender | undefined {
  try {
    const decoded: unknown = typeof value === 'string' ? JSON.parse(value) : value
    if (
      !decoded ||
      typeof decoded !== 'object' ||
      !('version' in decoded) ||
      decoded.version !== 1 ||
      !('sender' in decoded)
    ) {
      return
    }
    return readAgentMessageSource({ kind: 'agent', senders: [decoded.sender] })?.senders[0]
  } catch {
    return undefined
  }
}

export type MailDisplayAttachment = Readonly<{
  mailbox: string
  messageId: string
  runId: string
  from: string
  report: MailDisplayReport
}>

export type MailDisplayProjection = Readonly<{
  version: 1
  entries: readonly (MailDisplayAttachment & { itemId: string })[]
}>

export function mailDisplayAttachmentKey(value: Omit<MailDisplayAttachment, 'report'>): string {
  return JSON.stringify([value.mailbox, value.messageId, value.runId, value.from])
}

const projectedReports = new WeakMap<AgentJournalRenderItem, readonly MailDisplayAttachment[]>()

export function mailDisplayReportsForItem(
  item: AgentJournalRenderItem
): readonly MailDisplayAttachment[] | undefined {
  return projectedReports.get(item)
}

/** Bind response-only facts to their received items; removal/reset then releases them with the item. */
export function applyMailDisplayProjection(
  items: readonly AgentJournalRenderItem[],
  value: unknown
): AgentJournalRenderItem[] {
  const parsed = z.object({ version: z.literal(1), entries: z.array(z.unknown()) }).safeParse(value)
  if (!parsed.success) {
    return [...items]
  }
  const entrySchema = z.object({
    itemId: z.string(),
    mailbox: z.string(),
    messageId: z.string(),
    runId: z.string(),
    from: z.string(),
    report: z.unknown()
  })
  const byId = new Map<string, MailDisplayAttachment[]>()
  for (const value of parsed.data.entries) {
    const candidate = entrySchema.safeParse(value)
    if (!candidate.success) {
      continue
    }
    const entry = candidate.data
    const report = readMailDisplayReport(entry.report)
    if (report) {
      const list = byId.get(entry.itemId) ?? []
      list.push({ ...entry, report })
      byId.set(entry.itemId, list)
    }
  }
  return items.map((item) => {
    const mail = item.body.kind === 'message' ? item.body.from?.orchestration : undefined
    if (mail?.message !== 'mail-notice') {
      return item
    }
    const references = new Set(
      mail.messages.map((ref) => mailDisplayAttachmentKey({ ...ref, mailbox: mail.mailbox }))
    )
    const reports = byId
      .get(item.itemId)
      ?.filter((entry) => references.has(mailDisplayAttachmentKey(entry)))
    if (!reports?.length) {
      return item
    }
    const projected = { ...item }
    projectedReports.set(projected, reports)
    return projected
  })
}
