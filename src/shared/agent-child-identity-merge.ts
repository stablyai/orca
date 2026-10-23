/** Which agent a child is and the model it runs. */
type AgentChildIdentity = { agentType?: string; model?: string }

/** Agent type and model are one fact: a newly named agent type never inherits the prior one's
 *  model. A type named for the first time keeps a model already reported for the same child. */
export function mergeAgentChildIdentity(
  prior: AgentChildIdentity | undefined,
  observed: AgentChildIdentity
): { agentType: string | undefined; model: string | undefined } {
  const agentType = observed.agentType ?? prior?.agentType
  const sameAgent = prior?.agentType === undefined || agentType === prior.agentType
  return { agentType, model: observed.model ?? (sameAgent ? prior?.model : undefined) }
}
