// Share the `tool: input` line across agent rows, child rows and activity threads.

type AgentToolPreviewFields = { toolName?: string | null; toolInput?: string | null }

/** Only OSC 7501 programs may show bare input as their message; an agent’s orphaned tool argument needs a tool name. */
export function agentToolPreviewInput(
  entry: AgentToolPreviewFields,
  allowsBareInput: boolean
): string {
  const toolInput = entry.toolInput?.trim() ?? ''
  return entry.toolName?.trim() || allowsBareInput ? toolInput : ''
}

export function formatAgentToolPreviewLine(
  entry: AgentToolPreviewFields,
  allowsBareInput: boolean
): string {
  const toolName = entry.toolName?.trim() ?? ''
  const toolInput = agentToolPreviewInput(entry, allowsBareInput)
  if (toolName && toolInput) {
    return `${toolName}: ${toolInput}`
  }
  return toolName || toolInput
}
