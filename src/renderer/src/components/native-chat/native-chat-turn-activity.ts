import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { normalizePromptField } from '../../../../shared/agent-status-field-normalization'

export type NativeChatTurnActivity = { kind: 'description'; text: string }

function activityLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const latest = lines.at(-1)
  return latest ? normalizePromptField(latest) || null : null
}

/** Prefer provider-authored activity copy; callers provide the broad fallback. */
export function selectStructuredAgentTurnActivity(
  items: readonly AgentJournalRenderItem[],
  turnId: string | null
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
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const body = turnItems[index]?.body
    if (body?.kind !== 'status' || body.turnLifecycle || body.providerFrame) {
      continue
    }
    const text = activityLine(body.text)
    if (text) {
      return { kind: 'description', text }
    }
  }
  return null
}
