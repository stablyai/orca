// What a subagent roster entry says under its name, shared by desktop and mobile.

import { formatAgentToolPreviewLine } from '../../../agent-status/presentation/agent-tool-preview'
import { claudeListedModelLabel } from '../../../claude-model-list-probe'
import {
  nativeChatSessionChoiceShortLabel,
  type NativeChatSessionOptionSay
} from '../../input/session-options/native-chat-session-option-labels'
import type { NativeChatSubagentEntry } from '../../native-chat-types'
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
  // Lines become separate clauses, so list items don't run together on one row.
  const text =
    operation ||
    subagentMessageText(entry.lastMessage ?? '')
      .replace(/:\s*\n\s*/g, ': ')
      .replace(/\s*\n\s*/g, ' · ')
      .replace(/\s+/g, ' ')
  return text || null
}

/** What the subagent said, without the markdown marks a plain row or preview can't render. */
export function subagentMessageText(markdown: string): string {
  return markdown
    .replace(/^\s*```.*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+)/gm, '')
    .replace(/[`*~]|__/g, '')
    .trim()
}

/** `claude-opus-5-5` reads as `Opus 5.5`, `gpt-5.5` as `GPT-5.5`: the chat already names the provider. */
export function subagentModelLabel(model: string): string {
  return claudeListedModelLabel(model.trim())
    .replace(/^Claude /, '')
    .replace(/^GPT (\d)/, 'GPT-$1')
}

/** `general-purpose` reads as `General purpose`; Codex's bare `default` role says nothing. */
export function subagentRoleLabel(agentType: string | undefined): string | null {
  const words = agentType?.replace(/[-_]+/g, ' ').trim()
  return words && words !== 'default' ? words.charAt(0).toUpperCase() + words.slice(1) : null
}

/** `Opus 5.5 · High`, from whichever the provider reported. */
export function subagentEntryRunsOn(
  entry: NativeChatSubagentEntry,
  say: NativeChatSessionOptionSay
): string | null {
  const model = entry.model?.trim() ? subagentModelLabel(entry.model) : null
  const effort = entry.effort?.trim()
    ? nativeChatSessionChoiceShortLabel({ value: entry.effort, label: entry.effort }, say, 'effort')
    : null
  const parts = [model, effort].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : null
}
