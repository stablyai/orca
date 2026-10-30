// Return legacy unsent copies to the composer only if the host holds neither message nor card; delete only after durable hand-back.
// On the first release on/after 2027-04-01, replace legacy recovery with one-time prefix-key removal.

import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionWriteNoticePart } from '../../../../shared/agent-session-write-notice-copy'
import { agentSessionWriteNotDoneParts } from '../../../../shared/agent-session-refusal-notice'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { readStructuredAgentSessionConversationOutline } from '@/runtime/structured-agent-session-client'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { handBackStructuredAgentSessionMessage } from './structured-agent-session-message-hand-back'
import { setStructuredAgentSessionSendNotice } from './structured-agent-session-pending-sends'

const LEGACY_OUTBOX_PREFIX = 'orca:desktopStructuredAgentSessionOutbox:v1:'

type LegacyOutboxMessage = { clientMessageId: string; body: AgentJournalMessageItem }

function legacyKey(sessionId: string): string {
  return `${LEGACY_OUTBOX_PREFIX}${encodeURIComponent(sessionId)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readLegacyBody(value: unknown): AgentJournalMessageItem | null {
  if (!isRecord(value) || value.kind !== 'message' || value.role !== 'user') {
    return null
  }
  const blocks: AgentJournalMessageItem['blocks'] = []
  const stored: unknown[] = Array.isArray(value.blocks) ? value.blocks : []
  for (const block of stored) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text })
    } else if (isRecord(block) && block.type === 'image-ref' && typeof block.path === 'string') {
      blocks.push({ type: 'image-ref', path: block.path })
    }
  }
  return blocks.length > 0 ? { kind: 'message', role: 'user', blocks } : null
}

/** When the person sent it; an entry with none keeps its place after the dated ones. */
function legacyQueuedAt(entry: unknown): number {
  return isRecord(entry) && typeof entry.queuedAt === 'number' ? entry.queuedAt : Infinity
}

export function readLegacyStructuredAgentSessionOutbox(sessionId: string): LegacyOutboxMessage[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(legacyKey(sessionId)) ?? '[]')
    return Array.isArray(value)
      ? [...value]
          .sort((left: unknown, right: unknown) => legacyQueuedAt(left) - legacyQueuedAt(right))
          .flatMap((entry: unknown) => {
            const body = isRecord(entry) ? readLegacyBody(entry.body) : null
            // One the host recorded and then rejected is drawn by its own row as not sent.
            const hostRejected =
              isRecord(entry) &&
              entry.state === 'rejected' &&
              isRecord(entry.lastFailure) &&
              entry.lastFailure.kind === 'rejected'
            return body &&
              !hostRejected &&
              isRecord(entry) &&
              typeof entry.clientMessageId === 'string'
              ? [{ clientMessageId: entry.clientMessageId, body }]
              : []
          })
      : []
  } catch {
    return []
  }
}

const recovering = new Set<string>()

/** Check full host outline/queue, never just loaded pages; return missing messages as not sent only with complete evidence, otherwise unconfirmed. Never resend. */
export async function recoverLegacyStructuredAgentSessionOutbox(args: {
  sessionId: string
  target: RuntimeClientTarget
  submissions: readonly AgentJournalSubmission[]
  queuedMessageIds: readonly string[]
}): Promise<void> {
  const { sessionId } = args
  const messages = readLegacyStructuredAgentSessionOutbox(sessionId)
  if (messages.length === 0) {
    try {
      localStorage.removeItem(legacyKey(sessionId))
    } catch {
      // Nothing to recover; a key storage refuses to drop is read as empty again next time.
    }
    return
  }
  if (recovering.has(sessionId)) {
    return
  }
  recovering.add(sessionId)
  try {
    const outline = await readStructuredAgentSessionConversationOutline(
      args.target,
      sessionId
    ).catch(() => null)
    const held = new Set<string>(args.queuedMessageIds)
    for (const submission of args.submissions) {
      held.add(submission.clientMessageId)
      if (submission.queuedMessageId !== undefined) {
        held.add(submission.queuedMessageId)
      }
    }
    const drawn = new Set(outline?.entries.map((entry) => entry.itemId) ?? [])
    const whole = outline !== null && outline.omittedEntries === 0
    let durable = true
    let notice: AgentSessionWriteNoticePart[] | null = null
    for (const message of messages) {
      if (
        held.has(message.clientMessageId) ||
        drawn.has(agentJournalSubmissionKey(message.clientMessageId))
      ) {
        continue
      }
      durable =
        handBackStructuredAgentSessionMessage(sessionId, message.clientMessageId, message.body) &&
        durable
      notice =
        notice?.[0] === 'sendOutcomeLost' || !whole
          ? ['sendOutcomeLost']
          : agentSessionWriteNotDoneParts('composer-send')
    }
    if (notice) {
      setStructuredAgentSessionSendNotice(sessionId, agentSessionWriteNoticeText(notice))
    }
    if (durable) {
      localStorage.removeItem(legacyKey(sessionId))
    }
  } catch {
    // Storage refused: the copy stays for the next open, and nothing waits on it.
  } finally {
    recovering.delete(sessionId)
  }
}
