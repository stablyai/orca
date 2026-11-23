// The Memory page's topic files and archive: each opens as a file on the bot's page.
import { useEffect, useState } from 'react'
import { ExternalLink, FileText, History } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { type BotHome, readBotHomeFile } from '../../settings/bots/bot-home-files'
import { openBotHomeFileTab } from '../../settings/bots/bot-home-file-open'
import { BOT_MEMORY_ARCHIVE, useBotMemoryTopics } from '../../settings/bots/use-bot-memory-topics'
import { SettingsInsetGroup, SettingsInsetRow } from './BotSettingsRows'

const memoryPath = (name: string): string => `memory/${name}`

/** Each file's line count, read once the list is known; absent until its read lands. */
function useLineCounts(home: BotHome, names: readonly string[]): ReadonlyMap<string, number> {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map())
  const key = names.join('\u0000')
  useEffect(() => {
    let live = true
    for (const name of key ? key.split('\u0000') : []) {
      readBotHomeFile(home, memoryPath(name)).then(
        (content) => {
          const lines = content.split('\n').filter((line) => line.trim() !== '').length
          if (live) {
            setCounts((current) => new Map(current).set(name, lines))
          }
        },
        () => undefined
      )
    }
    return () => {
      live = false
    }
  }, [home, key])
  return counts
}

export function BotMemoryTopicFiles({
  bot,
  home
}: {
  bot: Bot
  home: BotHome
}): React.JSX.Element | null {
  const t = useTranslate()
  const listing = useBotMemoryTopics(home)
  const names = listing ? [...listing.topics, ...(listing.archive ? [BOT_MEMORY_ARCHIVE] : [])] : []
  const counts = useLineCounts(home, names)
  if (!listing || names.length === 0) {
    return null
  }
  const lines = (name: string): string | undefined => {
    const count = counts.get(name)
    if (count === undefined) {
      return undefined
    }
    return count === 1
      ? t('bots.share.oneLine', '1 line')
      : t('bots.share.lines', '{{count}} lines', { count })
  }
  const open = (name: string) => () => openBotHomeFileTab(bot, home, memoryPath(name))
  const openIcon = <ExternalLink className="size-3.5 text-muted-foreground" />
  return (
    <div className="flex flex-col gap-3.5">
      {listing.topics.length > 0 ? (
        <SettingsInsetGroup title={t('bots.settingsView.topicFiles', 'Topic files')}>
          {listing.topics.map((name) => (
            <SettingsInsetRow
              key={name}
              icon={<FileText />}
              title={name}
              detail={lines(name)}
              end={openIcon}
              onOpen={open(name)}
            />
          ))}
        </SettingsInsetGroup>
      ) : null}
      {listing.archive ? (
        <SettingsInsetGroup>
          <SettingsInsetRow
            icon={<History />}
            title={BOT_MEMORY_ARCHIVE}
            detail={lines(BOT_MEMORY_ARCHIVE)}
            end={openIcon}
            onOpen={open(BOT_MEMORY_ARCHIVE)}
          />
        </SettingsInsetGroup>
      ) : null}
    </div>
  )
}
