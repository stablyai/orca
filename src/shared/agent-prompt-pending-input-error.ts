export const AGENT_PROMPT_PENDING_INPUT_ERROR = 'agent_prompt_pending_input'

/** A submitting agent-prompt send refused because the composer already holds unsent text. */
export class AgentPromptPendingInputError extends Error {
  constructor(readonly pendingInput: string) {
    super(AGENT_PROMPT_PENDING_INPUT_ERROR)
    this.name = 'AgentPromptPendingInputError'
  }
}
