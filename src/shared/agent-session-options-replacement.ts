// What replaces a chat's saved options, and who chose the model they name.

/** Who chose a chat's model. `picker`: the user, in a model picker for this chat (including one a
 *  client held before the chat existed). `new-chat-default`: the remembered new-chat selection a
 *  create seeded from, which the user may never have picked for this chat. `caller`: a caller that
 *  named the model outright, such as `--model`. */
export type AgentSessionModelChooser = 'caller' | 'picker' | 'new-chat-default'

/** A stored chooser as this build reads it: a value it does not know (a newer build's) reads as
 *  absent, which means a caller's, rather than setting the whole chat aside. */
export function readAgentSessionModelChooser(value: unknown): AgentSessionModelChooser | undefined {
  return value === 'caller' || value === 'picker' || value === 'new-chat-default'
    ? value
    : undefined
}

/** Only a model the user's own selection named may be replaced once the list no longer offers it;
 *  a caller's, or one nobody recorded choosing, always runs as given. */
export function isReplaceableModelChoice(chosenBy: AgentSessionModelChooser | undefined): boolean {
  return chosenBy === 'picker' || chosenBy === 'new-chat-default'
}

export type AgentSessionOptionsReplacement = {
  sessionId: string
  fence: number
  options: Readonly<Record<string, string>>
  /** Who chose the model `options` name, when this replacement is what chose it. */
  modelChosenBy?: AgentSessionModelChooser
  now: number
}
