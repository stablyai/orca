import { readAgentJournalTurn } from './agent-session-turn-record'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { AgentSessionTurnActivity } from './agent-session-wire'
import { normalizePromptField } from './agent-status-field-normalization'
import { describeActiveToolCall, formatActiveToolLabel } from './native-chat-tool-activity'

export type NativeChatTurnActivity = { kind: 'description'; text: string }

function activityLine(text: string): string | null {
  let end = text.length
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const latest = text.slice(start, end).trim()
    if (latest) {
      return normalizePromptField(latest) || null
    }
    if (start === 0) {
      break
    }
    end = start - 1
  }
  return null
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
    const text = activityLine(body.text)
    if (text && !repeatsRecentToolLabel(text, toolLabels)) {
      return { kind: 'description', text }
    }
  }
  return null
}
