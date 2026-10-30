import type { AgentPickerEntry, AgentPickerDraft } from './agent-launch-picker'

export function agentPickerArgumentsKnown(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): boolean {
  if (draft.argumentsOwner !== undefined && draft.argumentsOwner !== entry.ownerKey) {
    return false
  }
  return (
    !entry.defaultsPending ||
    (draft.arguments !== undefined &&
      entry.ownerKey !== undefined &&
      draft.argumentsOwner === entry.ownerKey)
  )
}

export function agentPickerArgumentsText(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): string | undefined {
  return agentPickerArgumentsKnown(entry, draft)
    ? ((draft.arguments === undefined ? entry.arguments : draft.arguments) ?? '')
    : undefined
}
