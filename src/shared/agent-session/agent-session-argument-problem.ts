/** Orca's validated saved Arguments refusal. The option has no value or user-authored operand. */
export type AgentSessionArgumentProblem = {
  agent: 'Codex' | 'Claude'
  option: string
  problem: 'unsupportedOption' | 'missingValue' | 'multipleValues' | 'positionalPrompt'
}

export function readAgentSessionArgumentProblem(
  value: unknown
): AgentSessionArgumentProblem | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('agent' in value) ||
    !('problem' in value) ||
    !('option' in value)
  ) {
    return undefined
  }
  const agent = value.agent
  const problem = value.problem
  const option = value.option
  if (
    (agent !== 'Codex' && agent !== 'Claude') ||
    (problem !== 'unsupportedOption' &&
      problem !== 'missingValue' &&
      problem !== 'multipleValues' &&
      problem !== 'positionalPrompt') ||
    typeof option !== 'string' ||
    (problem === 'positionalPrompt'
      ? option !== 'prompt'
      : !/^(?:--[a-zA-Z][a-zA-Z0-9-]{0,63}|-[a-zA-Z]|--\?)$/.test(option))
  ) {
    return undefined
  }
  return { agent, option, problem }
}
