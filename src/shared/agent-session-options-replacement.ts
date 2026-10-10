// What replaces a chat's saved options, and who chose the model they name.

/** `picker`: the user, in a model picker, including the new-chat selection a create seeds from
 *  their picks. `caller`: a caller that named the model outright, such as `--model`. */
export type AgentSessionModelSource = 'picker' | 'caller'

export function isAgentSessionModelSource(value: unknown): value is AgentSessionModelSource {
  return value === 'picker' || value === 'caller'
}

export type AgentSessionOptionsReplacement = {
  sessionId: string
  fence: number
  options: Readonly<Record<string, string>>
  /** Who chose the model `options` name, when this replacement is what chose it. */
  modelSource?: AgentSessionModelSource
  now: number
}
