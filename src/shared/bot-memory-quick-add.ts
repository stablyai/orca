// An owner's Quick add, as Settings and the phone make it: on MEMORY.md and on Orca's record of it.

import {
  addBotMemoryFact,
  type BotMemoryChange,
  botMemoryChange,
  isEmptyBotMemoryChange
} from './bot-memory-lines'

/** What an owner's Quick add of `fact` asks of MEMORY.md (`file`) and Orca's record of it
 *  (`record`, null: not known yet): the new line; or, when the file already states the fact and
 *  the record doesn't (a chat wrote it mid-turn), that line for the record alone, so a turn end
 *  keeps it. Empty when both already state it. Throws when the add would save nothing. */
export function quickAddBotMemoryChange(
  file: string,
  record: string | null,
  fact: string,
  date: string
): BotMemoryChange {
  const next = addBotMemoryFact(file, fact, date)
  if (next === file) {
    return record === null
      ? { added: [], removed: [] }
      : botMemoryChange(record, addBotMemoryFact(record, fact, date))
  }
  const added = botMemoryChange(file, next)
  // Any other add that adds nothing would say it saved a fact it dropped.
  if (isEmptyBotMemoryChange(added)) {
    throw new Error('Could not add that to MEMORY.md; nothing was saved.')
  }
  return added
}
