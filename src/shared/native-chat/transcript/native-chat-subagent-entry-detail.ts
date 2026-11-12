// What a subagent roster entry says under its name, shared by desktop and mobile.

import { formatAgentToolPreviewLine } from '../../agent-status/presentation/agent-tool-preview'
import type { NativeChatSubagentEntry } from '../native-chat-types'
import { normalizeSubagentState } from './native-chat-subagent-summary'

/** While it works: the tool it runs, else what it last said. Once settled: what it said last, its result. */
export function subagentEntryDetail(entry: NativeChatSubagentEntry): string | null {
  const working = normalizeSubagentState(entry.state) === 'working'
  const operation =
    working && entry.operation
      ? formatAgentToolPreviewLine(
          { toolName: entry.operation.toolName, toolInput: entry.operation.input },
          false
        )
      : ''
  const text = operation || entry.lastMessage?.replace(/\s+/g, ' ').trim()
  return text || null
}

/** `model · effort`, from whichever the provider reported. */
export function subagentEntryRunsOn(entry: NativeChatSubagentEntry): string | null {
  const parts = [entry.model, entry.effort].filter((part): part is string => !!part?.trim())
  return parts.length > 0 ? parts.join(' · ') : null
}
