import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { normalizePromptField } from '../../../../shared/agent-status-field-normalization'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'

type ToolCall = Extract<NativeChatBlock, { type: 'tool-call' }>

export type NativeChatTurnActivity =
  | { kind: 'description'; text: string }
  | { kind: 'tool'; call: ToolCall }

function activityLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const latest = lines.at(-1)
  return latest ? normalizePromptField(latest) || null : null
}

/** Prefer provider-authored activity copy, then restate the latest tool in present tense. */
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
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const body = turnItems[index]?.body
    if (body?.kind === 'tool-call') {
      return {
        kind: 'tool',
        call: { type: 'tool-call', name: body.name, input: body.input, state: body.state }
      }
    }
    if (body?.kind === 'diff') {
      return {
        kind: 'tool',
        call: { type: 'tool-call', name: 'Diff', input: { path: body.path } }
      }
    }
  }
  return null
}
