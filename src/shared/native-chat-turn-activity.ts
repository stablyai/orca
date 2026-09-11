import { readAgentJournalTurn } from './agent-session-turn-record'
import {
  AGENT_JOURNAL_THINKING_PRESENTATION,
  type AgentJournalRenderItem
} from './agent-session-journal-types'
import type { AgentSessionTurnActivity } from './agent-session-wire'
import { normalizePromptField } from './agent-status-field-normalization'
import { describeActiveToolCall, formatActiveToolLabel } from './native-chat-tool-activity'

export type NativeChatTurnActivity = { kind: 'description'; text: string }

function activityLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const latest = lines.at(-1)
  return latest ? normalizePromptField(latest) || null : null
}

function recentToolActivityLabels(items: readonly AgentJournalRenderItem[]): Set<string> {
  const labels = new Set<string>()
  let foundRunning = false
  let foundSettled = false
  for (let index = items.length - 1; index >= 0 && (!foundRunning || !foundSettled); index -= 1) {
    const body = items[index]?.body
    if (body?.kind !== 'tool-call') {
      continue
    }
    const isRunning = body.state === 'running'
    if ((isRunning && foundRunning) || (!isRunning && foundSettled)) {
      continue
    }
    const descriptor = describeActiveToolCall({
      type: 'tool-call',
      name: body.name,
      input: body.input,
      state: body.state
    })
    const candidates = [
      formatActiveToolLabel(descriptor),
      descriptor.preview,
      descriptor.preview ? `${descriptor.toolName} ${descriptor.preview}` : descriptor.toolName
    ]
    for (const candidate of candidates) {
      const label = activityLine(candidate)?.toLowerCase()
      if (label) {
        labels.add(label)
      }
    }
    foundRunning ||= isRunning
    foundSettled ||= !isRunning
  }
  return labels
}

function repeatsRecentToolLabel(text: string, labels: ReadonlySet<string>): boolean {
  const normalized = text.toLowerCase()
  for (const label of labels) {
    if (
      normalized === label ||
      normalized.startsWith(`${label} `) ||
      normalized.endsWith(` ${label}`) ||
      normalized.includes(` ${label} `)
    ) {
      return true
    }
  }
  return false
}

/** Prefer provider-authored activity copy; callers provide the broad fallback. */
export function selectStructuredAgentTurnActivity(
  items: readonly AgentJournalRenderItem[],
  turnId: string | null,
  providerActivity?: AgentSessionTurnActivity | null
): NativeChatTurnActivity | null {
  if (!turnId) {
    return null
  }
  const turnStartIndex = items.findLastIndex((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn?.turnId === turnId && turn.state === 'running'
  })
  const turnItems = items.slice(Math.max(0, turnStartIndex))
  const toolLabels = recentToolActivityLabels(turnItems)
  if (providerActivity?.turnId === turnId) {
    const text = activityLine(providerActivity.text)
    if (text && !repeatsRecentToolLabel(text, toolLabels)) {
      return { kind: 'description', text }
    }
  }
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const body = turnItems[index]?.body
    if (body?.kind !== 'status' || readAgentJournalTurn(body) || body.providerFrame) {
      continue
    }
    // Reasoning is the turn's content, not a description of what it is doing. Letting it
    // through here would put the model's raw reasoning on the one-line indicator; it belongs
    // in the transcript, and the row falls back to saying the turn is thinking instead.
    if (body.presentation === AGENT_JOURNAL_THINKING_PRESENTATION) {
      continue
    }
    const text = activityLine(body.text)
    if (text && !repeatsRecentToolLabel(text, toolLabels)) {
      return { kind: 'description', text }
    }
  }
  return null
}
