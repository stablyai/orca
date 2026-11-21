import { applyAgentCopy, type AgentCopy, type AgentCopySettings } from '../catalog/agent-copies'
import type { TuiAgent } from '../catalog/tui-agent'
import {
  nativeChatPreferenceFor,
  type NativeChatDefaultSettings
} from '../choices/structured-native-chat-launch-route'
import { agentCopyMenuRows } from './agent-copy-menu-rows'
import {
  agentPickerChoiceSeeds,
  type AgentPickerDefaultSettings
} from './agent-launch-picker-defaults'
import type { AgentPickerEntry } from './agent-launch-picker'

export type AgentPickerCopySettings = AgentCopySettings &
  AgentPickerDefaultSettings &
  NativeChatDefaultSettings

/** Each saved copy as its own picker entry, right after its base agent's: the same models,
 *  efforts and Chat | CLI surfaces as the base, seeded with the copy's own setup. */
export function withAgentPickerCopyEntries(
  entries: readonly AgentPickerEntry[],
  copies: readonly AgentCopy[],
  detected: readonly TuiAgent[] | null,
  settings: AgentPickerCopySettings | null | undefined
): AgentPickerEntry[] {
  if (!copies.length) {
    return [...entries]
  }
  return entries.flatMap((entry) => [
    entry,
    ...(entry.copy
      ? []
      : copies.flatMap((copy) => {
          const copyEntry =
            copy.agent === entry.agent
              ? agentPickerCopyEntry(entry, copy, detected, settings)
              : null
          return copyEntry ? [copyEntry] : []
        }))
  ])
}

function agentPickerCopyEntry(
  base: AgentPickerEntry,
  copy: AgentCopy,
  detected: readonly TuiAgent[] | null,
  settings: AgentPickerCopySettings | null | undefined
): AgentPickerEntry | null {
  if (copy.disabled) {
    return null
  }
  const rows = agentCopyMenuRows(base.rows, [copy], detected, settings)
  // No rows: the base runs on a host that does not have this desktop's copies.
  if (!rows.length) {
    return null
  }
  const applied = applyAgentCopy(settings ?? {}, copy)
  const surfaces = [...base.surfaces]
  const prefersChat = nativeChatPreferenceFor(applied, copy.agent)
  return {
    ...base,
    label: copy.name,
    aliases: [...(base.aliases ?? []), copy.id],
    rows,
    surfaces,
    defaultSurface:
      prefersChat && surfaces.includes('chat')
        ? 'chat'
        : surfaces.includes('terminal')
          ? 'terminal'
          : base.defaultSurface,
    ...agentPickerChoiceSeeds(copy.agent, applied),
    copy: { id: copy.id, name: copy.name }
  }
}
