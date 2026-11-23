// The topic files in a bot's memory/ folder, for the Memory row's state line and the Memory page's list.
import { useEffect, useState } from 'react'
import { BOT_MEMORY_ARCHIVE } from '../../../../../shared/bots/bot-memory-archive'
import { isConfirmedFileNotFoundError } from '../../../../../shared/file-write/file-write-disk-precondition'
import { type BotHome, botHomeKey, readBotHomeDir } from './bot-home-files'
import { useStableBotHome } from './use-bot-home-file'

export type BotMemoryTopics = {
  /** Topic file names, sorted; the archive is not one. */
  topics: readonly string[]
  archive: boolean
}

const NONE: BotMemoryTopics = { topics: [], archive: false }

// Last read per home, so a page shown again starts from it while one listing refreshes it.
const cache = new Map<string, BotMemoryTopics>()

async function readTopics(home: BotHome): Promise<BotMemoryTopics> {
  try {
    const names = (await readBotHomeDir(home, 'memory'))
      .filter((entry) => !entry.isDirectory && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
    return {
      topics: names.filter((name) => name !== BOT_MEMORY_ARCHIVE).sort(),
      archive: names.includes(BOT_MEMORY_ARCHIVE)
    }
  } catch (error) {
    // No memory/ folder yet: no topic files.
    if (isConfirmedFileNotFoundError(error)) {
      return NONE
    }
    throw error
  }
}

/** The listing, read on the bot's host when shown; null until it lands, and when it can't be read. */
export function useBotMemoryTopics(listedHome: BotHome): BotMemoryTopics | null {
  const home = useStableBotHome(listedHome)
  const key = botHomeKey(home)
  const [read, setRead] = useState<{ key: string; topics: BotMemoryTopics | null }>(() => ({
    key,
    topics: cache.get(key) ?? null
  }))
  useEffect(() => {
    let live = true
    readTopics(home).then(
      (topics) => {
        cache.set(key, topics)
        if (live) {
          setRead({ key, topics })
        }
      },
      () => live && setRead({ key, topics: null })
    )
    return () => {
      live = false
    }
  }, [home, key])
  return read.key === key ? read.topics : (cache.get(key) ?? null)
}

/** How many topic files; null until read or when the read fails. */
export function useBotMemoryTopicCount(home: BotHome): number | null {
  return useBotMemoryTopics(home)?.topics.length ?? null
}
