// An owner's Quick add, as Settings and the phone make it: on MEMORY.md and on Orca's record of it.

import {
  addBotMemoryFact,
  type BotMemoryChange,
  botMemoryChange,
  isEmptyBotMemoryChange,
  parseBotMemoryFacts
} from './bot-memory-lines'

/** Why a Quick add with no fact's words in it was refused. */
export const BOT_MEMORY_NO_FACT = 'bot_memory_no_fact'

/** Whether `text` has a fact's words: not blank, and not only a bullet or separator ("-", ":"),
 *  which would leave a fact Forget can't find. */
export function botMemoryFactHasWords(text: string): boolean {
  return text.trim() !== '' && Boolean(parseBotMemoryFacts(`- ${text.trim()}`)[0]?.text)
}

/** What an owner's Quick add of `fact` asks of MEMORY.md (`file`) and Orca's record of it
 *  (`record`, null: not known yet): the new line; or, when the file already states the fact
 *  (`stated`) and the record doesn't (a chat wrote it mid-turn), that line for the record, which
 *  keeps it through the chat's turn end. Empty when both already state it. Throws when the add has
 *  no words (BOT_MEMORY_NO_FACT) or would save nothing. */
export function quickAddBotMemoryChange(
  file: string,
  record: string | null,
  fact: string,
  date: string
): { change: BotMemoryChange; stated: boolean } {
  if (!botMemoryFactHasWords(fact)) {
    throw new Error(BOT_MEMORY_NO_FACT)
  }
  const next = addBotMemoryFact(file, fact, date)
  if (next === file) {
    const change =
      record === null
        ? { added: [], removed: [] }
        : botMemoryChange(record, addBotMemoryFact(record, fact, date))
    return { change, stated: true }
  }
  const added = botMemoryChange(file, next)
  // Any other add that adds nothing would say it saved a fact it dropped.
  if (isEmptyBotMemoryChange(added)) {
    throw new Error('Could not add that to MEMORY.md; nothing was saved.')
  }
  return { change: added, stated: false }
}
