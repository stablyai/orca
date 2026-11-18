/** A bot's final message ending with this has nothing worth reporting, so nobody is told. */
export const BOT_QUIET_MARKER = 'NO_REPLY'

// The marker as the message's last word, however the model dressed it: `NO_REPLY`, **NO_REPLY**,
// NO_REPLY., **NO_REPLY.** A word that only contains it (XNO_REPLY) doesn't count.
const QUIET_ENDING = new RegExp(`(?:^|\\s)[\`*_]*${BOT_QUIET_MARKER}[\`*_.!]*\\s*$`)

export function isQuietBotResult(message: string): boolean {
  return QUIET_ENDING.test(message)
}

/** What a quiet message said before its marker; empty when it was only the marker. */
export function quietBotResultText(message: string): string {
  return message.replace(QUIET_ENDING, '').trimEnd()
}
