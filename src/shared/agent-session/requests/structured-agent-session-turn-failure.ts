import type {
  AgentJournalRenderItem,
  AgentJournalStatusItem
} from '../journal/agent-session-journal-types'
import {
  readAgentSessionFailureFact,
  type AgentSessionFailureFact
} from '../failures/agent-session-failure'
import { agentSessionFailureSentence } from '../failures/agent-session-failure-words'
import {
  agentSessionFailureDetailText,
  quotedProviderDetail
} from '../failures/agent-session-failure-quoted-detail'
import { isRootAgentJournalItem } from '../journal/agent-session-journal-producer'
import { sanitizeCrashReportString } from '../../crash-reporting/crash-report-redaction'
import { stripAnsiControlSequences } from '../../source-control/ai/generation/commit-message-agent-output'

const MAX_FAILURE_LINE_LENGTH = 512

/** One turn's own root status rows, newest first. */
function* turnStatusRows(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string
): Generator<AgentJournalStatusItem> {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (
      item?.turnScope?.kind === 'turn' &&
      item.turnScope.turnItemId === turnItemId &&
      isRootAgentJournalItem(item) &&
      item.body.kind === 'status'
    ) {
      yield item.body
    }
  }
}

/** Why one turn failed, from its own newest root failure row; a retry in progress is not why. */
export function structuredAgentSessionTurnFailure(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string
): AgentSessionFailureFact | undefined {
  for (const body of turnStatusRows(items, turnItemId)) {
    if (body.failure && body.failure.kind !== 'providerRetrying') {
      return readAgentSessionFailureFact(body.failure)
    }
  }
  return undefined
}

// Redact before bounding; the provider's full text stays in the Chat's disclosure.
function failureLine(text: string): string {
  return sanitizeCrashReportString(
    stripAnsiControlSequences(text).split(/\r?\n/)[0] ?? '',
    MAX_FAILURE_LINE_LENGTH
  )
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim()
}

/** One redacted line saying why one turn failed: its typed failure, or the provider's own error. */
export function structuredAgentSessionTurnFailureLine(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string
): string | undefined {
  return structuredAgentSessionTurnFailureReport(items, turnItemId).error
}

/** The fact and the redacted line from the same status row. */
export function structuredAgentSessionTurnFailureReport(
  items: readonly AgentJournalRenderItem[],
  turnItemId: string
): { error?: string; failure?: AgentSessionFailureFact } {
  for (const body of turnStatusRows(items, turnItemId)) {
    const fact = readAgentSessionFailureFact(body.failure)
    if (fact?.kind === 'providerRetrying') {
      continue
    }
    const text = fact
      ? agentSessionFailureSentence(fact, 'row')
      : body.tone === 'error' && body.providerFrame
        ? body.text
        : undefined
    const line = text ? failureLine(text) : ''
    if (line) {
      return { error: line, ...(fact ? { failure: fact } : {}) }
    }
  }
  return {}
}

/** One redacted line saying why a send was refused before any turn, such as "Codex couldn't start:
 *  <details>". */
export function structuredAgentSessionRefusalLine(
  rejection: unknown,
  agentName: string | undefined
): string | undefined {
  const fact = readAgentSessionFailureFact(rejection)
  if (!fact) {
    return undefined
  }
  // A run is rerun, not resent, so the chat's "send again" advice is left out.
  const lead = agentSessionFailureSentence(fact, 'rejection', {
    ...(agentName ? { agentName } : {}),
    retryControl: true
  })
  const detail = agentSessionFailureDetailText(fact)
  // Some sentences already quote the provider's words or name the refused model.
  const appended = detail && !lead.includes(quotedProviderDetail(detail)) ? detail : undefined
  const text = appended ? `${lead.replace(/\.$/, '')}: ${appended}` : lead
  // One line: a provider's multi-line words would otherwise be cut at the first break.
  return failureLine(text.replace(/\s+/g, ' ')) || undefined
}
