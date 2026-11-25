import { useTranslate } from '@/i18n/use-translate'
import { ChevronRight } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { openBotSettings } from '@/components/bots/bot-settings-open'
import {
  BOT_MEMORY_UPDATED_COPY as COPY,
  botMemoryUpdatedRows,
  botMemoryUpdatedSummary,
  type BotMemoryUpdatedNote,
  type BotMemoryUpdatedRow
} from '../../../../shared/bots/bot-memory-updated-note'

function ReceiptRow({ row }: { row: BotMemoryUpdatedRow }): React.JSX.Element {
  const t = useTranslate()
  const label = <span className="mr-2 text-xs text-chat-foreground-faint">{rowLabel(row, t)}</span>
  if (row.change === 'removed') {
    return (
      <p>
        {label}
        <s>{row.text}</s>
      </p>
    )
  }
  return (
    <p>
      {label}
      {row.change === 'noteChanged' ? (
        <span className="font-mono text-xs">{row.text}</span>
      ) : (
        row.text
      )}
    </p>
  )
}

function rowLabel(row: BotMemoryUpdatedRow, t: ReturnType<typeof useTranslate>): string {
  switch (row.change) {
    case 'added':
      return t('components.native-chat.memoryUpdated.added', COPY.added)
    case 'removed':
      return t('components.native-chat.memoryUpdated.removed', COPY.removed)
    case 'noteChanged':
      return t('components.native-chat.memoryUpdated.noteChanged', COPY.noteChanged)
  }
}

export function NativeChatMemoryUpdatedRow({
  note
}: {
  note: BotMemoryUpdatedNote
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Collapsible className="min-w-0 max-w-full">
      <CollapsibleTrigger variant="chat">
        <span className="min-w-0">{botMemoryUpdatedSummary(note)}</span>
        <ChevronRight
          aria-hidden
          className="mt-1 size-3.5 shrink-0 transition-transform duration-150 group-data-[state=open]:rotate-90 motion-reduce:transition-none"
        />
      </CollapsibleTrigger>
      <CollapsibleContent animation="fade">
        <div className="mt-1 space-y-2 border-l-2 border-border py-1 pl-3 text-chat-foreground [overflow-wrap:anywhere]">
          {botMemoryUpdatedRows(note).map((row) => (
            <ReceiptRow key={`${row.change}:${row.key}`} row={row} />
          ))}
          {note.otherChanges > 0 ? (
            <p>{t('components.native-chat.memoryUpdated.indexChanged', COPY.indexChanged)}</p>
          ) : null}
          <button
            type="button"
            onClick={() => openBotSettings(note.botId, 'memory')}
            className="rounded-md text-xs text-chat-foreground-faint underline underline-offset-2 hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('components.native-chat.memoryUpdated.openMemory', COPY.openMemory)}
          </button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
