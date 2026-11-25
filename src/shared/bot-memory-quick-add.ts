// An owner's Quick add, as Settings and the phone make it.

import {
  addBotMemoryFact,
  type BotMemoryChange,
  botMemoryChange,
  isEmptyBotMemoryChange,
  parseBotMemoryFacts
} from './bot-memory-lines'

/** Why a Quick add with no fact's words in it was refused. */
export const BOT_MEMORY_NO_FACT = 'bot_memory_no_fact'

/** Whether `text` has a fact's words once written as Quick add writes it: not blank, and not only a
 *  bullet or separator ("-", ":", "–"), which would leave a fact Forget can't find. */
export function botMemoryFactHasWords(text: string): boolean {
  // Any date reads the same: the line is "- <date> <text>".
  const written = addBotMemoryFact('', text, '2000-01-01')
  return text.trim() !== '' && Boolean(parseBotMemoryFacts(written)[0]?.text)
}

/** What an owner's Quick add of `fact` asks of MEMORY.md (`file`): the new line, and whether the
 *  file already states the fact (`stated`), when it asks nothing. Throws when the add has no
 *  words (BOT_MEMORY_NO_FACT) or would save nothing. */
export function quickAddBotMemoryChange(
  file: string,
  fact: string,
  date: string
): { change: BotMemoryChange; stated: boolean } {
  if (!botMemoryFactHasWords(fact)) {
    throw new Error(BOT_MEMORY_NO_FACT)
  }
  const next = addBotMemoryFact(file, fact, date)
  if (next === file) {
    return { change: { added: [], removed: [] }, stated: true }
  }
  const added = botMemoryChange(file, next)
  // Any other add that adds nothing would say it saved a fact it dropped.
  if (isEmptyBotMemoryChange(added)) {
    throw new Error('Could not add that to MEMORY.md; nothing was saved.')
  }
  return { change: added, stated: false }
}
