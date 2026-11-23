/** Orca's turn to a bot it just created; the chat shows a notice row in its place. */
export const BOT_CREATED_KICKOFF = 'Orca: you were just created. Start your first-run setup.'

/** What status shows as the kickoff turn's prompt, since the owner never typed it. */
export const BOT_CREATED_STATUS_LABEL = 'Getting set up'

/** A hook reports the kickoff as the agent's prompt, so status producers relabel it. An import's
 *  kickoff starts with it too. */
export function isBotCreatedKickoff(prompt: string): boolean {
  return prompt.trim().startsWith(BOT_CREATED_KICKOFF)
}
