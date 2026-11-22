import { CODEX_ASYNC_QUESTION_TOOL } from '../../native-chat/input/questions/codex-async-question-input'

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

/** The question is the news; its tool id would push it out of a narrow row. */
export function agentToolPreviewName(toolName: string, toolInput: string): string {
  return toolInput && toolName === CODEX_ASYNC_QUESTION_TOOL ? '' : toolName
}

export function formatAgentToolPreviewLine(
  entry: AgentToolPreviewFields,
  allowsBareInput: boolean
): string {
  const toolInput = agentToolPreviewInput(entry, allowsBareInput)
  const toolName = agentToolPreviewName(entry.toolName?.trim() ?? '', toolInput)
  if (toolName && toolInput) {
    return `${toolName}: ${toolInput}`
  }
  return toolName || toolInput
}
