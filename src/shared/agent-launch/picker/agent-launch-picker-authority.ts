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
    ((draft.arguments !== undefined || draft.pendingArguments !== undefined) &&
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

export function currentAgentPickerDraft(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): AgentPickerDraft {
  return (draft.arguments !== undefined || draft.pendingArguments !== undefined) &&
    draft.argumentsOwner !== entry.ownerKey
    ? { ...draft, argumentsOwner: entry.ownerKey }
    : draft
}

export type AgentPickerRetainedSetup = {
  target: AgentPickerEntry['draftTarget']
  agent: AgentPickerEntry['agent']
  preset?: { model: string; effort?: string }
  source: AgentPickerDraft | undefined
  draft: AgentPickerDraft
  active: boolean
}

/** Launch has no Arguments editor, so Arguments a speed edit copied from older settings yield to the current ones. */
export function launchAgentPickerDraft(
  entry: AgentPickerEntry,
  draft: AgentPickerDraft
): AgentPickerDraft {
  if (draft.argumentsOwner === undefined || draft.argumentsOwner === entry.ownerKey) {
    return draft
  }
  const {
    arguments: _arguments,
    pendingArguments: _pending,
    argumentsOwner: _owner,
    ...rest
  } = draft
  return rest
}
