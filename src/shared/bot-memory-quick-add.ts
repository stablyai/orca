// An owner's Quick add, as Settings and the phone make it: on MEMORY.md and on Orca's record of it.

import {
  addBotMemoryFact,
  type BotMemoryChange,
  botMemoryChange,
  isEmptyBotMemoryChange,
  parseBotMemoryFacts
} from './bot-memory-lines'

/** What an owner's Quick add of `fact` asks of MEMORY.md (`file`) and Orca's record of it
 *  (`record`, null: not known yet): the new line; or, when the file already states the fact
 *  (`stated`) and the record doesn't (a chat wrote it mid-turn), that line for the record, which
 *  keeps it through the chat's turn end. Empty when both already state it. Throws when the add is
 *  blank or would save nothing. */
export function quickAddBotMemoryChange(
  file: string,
  record: string | null,
  fact: string,
  date: string
): { change: BotMemoryChange; stated: boolean } {
  // Blank, or only a bullet or separator ("-", ":"): no words, so no fact Forget could find.
  if (fact.trim() === '' || !parseBotMemoryFacts(`- ${fact.trim()}`)[0]?.text) {
    throw new Error('Missing text')
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
