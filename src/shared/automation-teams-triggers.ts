// Microsoft Teams automation rules: matched on the host that holds the Teams sign-in, like Gmail's, so
// they are never sent to Orca Cloud and an older cloud never sees them.

const MAX_FILTER_LENGTH = 200
const MAX_PLACES = 10
// The chat ref `orca teams find` prints.
const CHAT_REF = /^teams:chat\/19:[\w.@=-]+$/

/**
 * A message in one of the signed-in person's Teams chats that @mentions them, from someone else. The
 * bot acts as that person in Teams, so a mention of them is a mention of the bot.
 */
export type AutomationTeamsTrigger = {
  id: string
  source: 'teams'
  event: 'mentioned'
  /** Chat refs (`teams:chat/…`); absent listens in every chat. */
  in?: string[]
  /** Matched case-insensitively against the message's text. */
  textContains?: string
}

export function isTeamsTrigger<Rule extends { source: string }>(
  trigger: Rule
): trigger is Extract<Rule, { source: 'teams' }> {
  return trigger.source === 'teams'
}

export function assertTeamsTrigger(trigger: AutomationTeamsTrigger): void {
  if (
    (trigger.in?.length ?? 0) > MAX_PLACES ||
    (trigger.textContains?.length ?? 0) > MAX_FILTER_LENGTH
  ) {
    throw new Error("The teams.mentioned trigger's filters are too long.")
  }
  const wrong = trigger.in?.find((ref) => !CHAT_REF.test(ref))
  if (wrong !== undefined) {
    throw new Error(
      `teams.mentioned listens in chats only; "${wrong.slice(0, 80)}" is not a chat ref from \`orca teams find\`.`
    )
  }
}
