import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionTurnActivity } from '../../../../shared/agent-session-wire'
import { normalizePromptField } from '../../../../shared/agent-status-field-normalization'
import {
  describeActiveToolCall,
  formatActiveToolLabel
} from '../../../../shared/native-chat-tool-activity'

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
  const turnStartIndex = items.findLastIndex(
    (item) =>
      item.body.kind === 'status' &&
      item.body.turnLifecycle?.turnId === turnId &&
      item.body.turnLifecycle.state === 'running'
  )
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
    if (body?.kind !== 'status' || body.turnLifecycle || body.providerFrame) {
      continue
    }
    const text = activityLine(body.text)
    if (text && !repeatsRecentToolLabel(text, toolLabels)) {
      return { kind: 'description', text }
    }
  }
  return null
}
