import { useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { type BotRef, useStableBotRef } from '@/lib/bot-hosts'
import { useTranslate } from '@/i18n/use-translate'
import {
  editBotMemory,
  forgetBotMemory,
  readBotMemoryHistory,
  undoBotMemoryChange
} from '@/lib/bot-catalog'
import { parseBotMemoryFacts } from '../../../../../shared/bot-memory-lines'
import { BotMemoryHistory } from './BotMemoryHistory'
import { type BotMemoryEdits, BotMemoryList } from './BotMemoryList'
import type { BotHomeFile } from './use-bot-home-file'

/** A bot's memory in Settings: what it knows, and every change to it with Undo. */
export function BotMemoryPanel({
  bot: listed,
  file,
  defaultTab = 'facts',
  onOpenAsFile,
  children
}: {
  bot: BotRef
  file: Pick<BotHomeFile, 'refresh'> & { disk: string }
  defaultTab?: 'facts' | 'history'
  onOpenAsFile?: () => void
  /** After the facts, on What it knows: the topic files. */
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const bot = useStableBotRef(listed)
  const factCount = useMemo(() => parseBotMemoryFacts(file.disk).length, [file.disk])
  const edits = useMemo<BotMemoryEdits>(
    () => ({
      add: async (text) => {
        const { alreadyInMemory } = await editBotMemory(bot, text)
        if (alreadyInMemory) {
          toast.info(t('settings.bots.memoryAlreadySaved', 'That fact is already in memory.'))
        }
      },
      reword: async (fact, text) => {
        await editBotMemory(bot, text, fact)
      },
      forget: (fact) => forgetBotMemory(bot, fact)
    }),
    [bot, t]
  )
  const load = useCallback(() => readBotMemoryHistory(bot), [bot])
  const undo = useCallback((id: string) => undoBotMemoryChange(bot, id), [bot])
  return (
    <Tabs defaultValue={defaultTab}>
      <TabsList size="sm" className="w-full">
        <TabsTrigger value="facts">
          {t('settings.bots.memoryTabs.facts', 'What it knows')}
          {factCount > 0 ? (
            <span className="ml-1 rounded-full bg-foreground/[0.08] px-1.5 py-px text-3xs font-medium text-muted-foreground tabular-nums">
              {factCount}
            </span>
          ) : null}
        </TabsTrigger>
        <TabsTrigger value="history">
          {t('settings.bots.memoryTabs.history', 'History')}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="facts" className="mt-1">
        <div className="flex flex-col gap-3.5">
          <BotMemoryList file={file} edits={edits} onOpenAsFile={onOpenAsFile} />
          {children}
        </div>
      </TabsContent>
      <TabsContent value="history" className="mt-1">
        <BotMemoryHistory load={load} undo={undo} version={file.disk} onChanged={file.refresh} />
      </TabsContent>
    </Tabs>
  )
}
