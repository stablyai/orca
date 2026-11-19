import { useCallback, useMemo } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { type BotRef, useStableBotRef } from '@/lib/bot-hosts'
import { useTranslate } from '@/i18n/use-translate'
import {
  editBotMemory,
  forgetBotMemory,
  readBotMemoryHistory,
  undoBotMemoryChange
} from '@/lib/bot-catalog'
import { BotMemoryHistory } from './BotMemoryHistory'
import { type BotMemoryEdits, BotMemoryList } from './BotMemoryList'
import type { BotHomeFile } from './use-bot-home-file'

/** A bot's memory in Settings: what it knows, and every change to it with Undo. */
export function BotMemoryPanel({
  bot: listed,
  file,
  defaultTab = 'facts',
  children
}: {
  bot: BotRef
  file: Pick<BotHomeFile, 'refresh'> & { disk: string }
  defaultTab?: 'facts' | 'history'
  /** After the facts, on What it knows: the topic files. */
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const bot = useStableBotRef(listed)
  const edits = useMemo<BotMemoryEdits>(
    () => ({
      add: (text) => editBotMemory(bot, text),
      reword: (fact, text) => editBotMemory(bot, text, fact),
      forget: (fact) => forgetBotMemory(bot, fact)
    }),
    [bot]
  )
  const load = useCallback(() => readBotMemoryHistory(bot), [bot])
  const undo = useCallback((id: string) => undoBotMemoryChange(bot, id), [bot])
  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList size="sm">
        <TabsTrigger value="facts">
          {t('settings.bots.memoryTabs.facts', 'What it knows')}
        </TabsTrigger>
        <TabsTrigger value="history">
          {t('settings.bots.memoryTabs.history', 'History')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="facts">
        <BotMemoryList file={file} edits={edits} />
        {children}
      </TabsContent>
      <TabsContent value="history">
        <BotMemoryHistory load={load} undo={undo} version={file.disk} onChanged={file.refresh} />
      </TabsContent>
    </Tabs>
  )
}
