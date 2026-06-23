export type AgentComboboxCommandState = {
  commandValue: string
  activeCommandValue: string
}

export function createAgentComboboxCommandState(commandValue: string): AgentComboboxCommandState {
  return {
    commandValue,
    activeCommandValue: commandValue
  }
}

export function resolveAgentComboboxCommandState(
  state: AgentComboboxCommandState,
  open: boolean,
  activeCommandValue: string
): AgentComboboxCommandState {
  if (!open || state.activeCommandValue === activeCommandValue) {
    return state
  }
  return {
    commandValue: activeCommandValue,
    activeCommandValue
  }
}

export function updateAgentComboboxCommandValue(
  state: AgentComboboxCommandState,
  commandValue: string
): AgentComboboxCommandState {
  if (state.commandValue === commandValue) {
    return state
  }
  return {
    ...state,
    commandValue
  }
}
