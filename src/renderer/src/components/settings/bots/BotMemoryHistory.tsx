import { useEffect, useState } from 'react'
import { Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { botErrorMessage } from '@/components/bots/bot-presentation'
import { type BotMemoryLine, parseBotMemoryFacts } from '../../../../../shared/bot-memory-lines'
import type { BotMemoryHistoryView } from '../../../../../shared/bots/bot-memory-history'

const DAY_MS = 24 * 60 * 60 * 1000

/** The line without its bullet, for the opened change. */
function bare({ line }: BotMemoryLine): string {
  return line.replace(/^\s*[-*]\s+/, '').trim()
}

function factText({ line }: BotMemoryLine): string {
  return parseBotMemoryFacts(line)[0]?.text ?? line.trim()
}

/** What changed, in a few words. */
function summary({ by, change }: BotMemoryHistoryView): string {
  const { added, removed } = change
  // One row for the whole night, so it says so rather than naming one change.
  if (by.kind === 'tidy-up') {
    return translate('settings.bots.memoryHistory.tidied', 'Tidied {{count}} lines', {
      count: added.length + removed.length
    })
  }
  if (by.kind === 'kept') {
    return added.length === 1
      ? translate('settings.bots.memoryHistory.keptOne', 'Kept a line another chat wrote over')
      : translate(
          'settings.bots.memoryHistory.keptMany',
          'Kept {{count}} lines other chats wrote over',
          { count: added.length }
        )
  }
  if (added.length === 1 && removed.length <= 1) {
    const fact = factText(added[0])
    return removed.length === 0
      ? translate('settings.bots.memoryHistory.added', 'Added: {{fact}}', { fact })
      : translate('settings.bots.memoryHistory.edited', 'Edited: {{fact}}', { fact })
  }
  if (added.length === 0 && removed.length === 1) {
    return translate('settings.bots.memoryHistory.forgot', 'Forgot: {{fact}}', {
      fact: factText(removed[0])
    })
  }
  if (removed.length === 0) {
    return translate('settings.bots.memoryHistory.addedMany', 'Added {{count}} lines', {
      count: added.length
    })
  }
  return added.length === 0
    ? translate('settings.bots.memoryHistory.forgotMany', 'Forgot {{count}} lines', {
        count: removed.length
      })
    : translate('settings.bots.memoryHistory.changedMany', 'Changed {{count}} lines', {
        count: added.length + removed.length
      })
}

/** Who made it. */
function author({ by, chat }: BotMemoryHistoryView): string {
  const named = chat
    ? translate('settings.bots.memoryHistory.chat', 'Chat "{{title}}"', { title: chat })
    : translate('settings.bots.memoryHistory.aChat', 'A chat')
  switch (by.kind) {
    case 'chat':
      return by.source
        ? translate('settings.bots.memoryHistory.chatFrom', '{{chat}} · from {{source}}', {
            chat: named,
            source: by.source
          })
        : named
    case 'kept':
      return translate('settings.bots.memoryHistory.kept', 'Orca · {{chat}} wrote over it', {
        chat: named
      })
    case 'owner':
      return translate('settings.bots.memoryHistory.owner', 'You, in Settings')
    case 'bot':
      return translate('settings.bots.memoryHistory.bot', 'Forget, from {{chat}}', {
        chat: named
      })
    case 'undo':
      return translate('settings.bots.memoryHistory.undo', 'Undo')
    case 'tidy-up':
      return translate(
        'settings.bots.memoryHistory.tidyUp',
        'Tidy-up · Undo puts back all of its MEMORY.md changes'
      )
  }
}

function dayLabel(at: number, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (at >= today) {
    return translate('settings.bots.memoryHistory.today', 'Today')
  }
  if (at >= today - DAY_MS) {
    return translate('settings.bots.memoryHistory.yesterday', 'Yesterday')
  }
  return new Date(at).toLocaleDateString(getIntlLocale(), { month: 'short', day: 'numeric' })
}

function Row({
  row,
  open,
  onToggle,
  onUndo
}: {
  row: BotMemoryHistoryView
  open: boolean
  onToggle: () => void
  onUndo: () => void
}): React.JSX.Element {
  const intlLocale = useIntlLocale()
  const t = useTranslate()
  const time = new Date(row.at).toLocaleTimeString(intlLocale, {
    hour: 'numeric',
    minute: '2-digit'
  })
  return (
    <li className="group flex items-start gap-3 rounded-md px-2 hover:bg-accent">
      <button
        type="button"
        aria-expanded={open}
        className="min-w-0 flex-1 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onToggle}
      >
        <span className="block truncate text-sm">{summary(row)}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {row.undoable
            ? author(row)
            : t(
                'settings.bots.memoryHistory.secret',
                '{{author}} · Can’t be undone: it held a secret',
                {
                  author: author(row)
                }
              )}
        </span>
        {open ? (
          <span className="mt-1.5 block space-y-0.5 border-l-2 border-border pl-2.5 font-mono text-xs">
            {row.change.removed.map((entry) => (
              <span key={`-${entry.line}`} className="block truncate text-muted-foreground">
                − <s>{bare(entry)}</s>
              </span>
            ))}
            {row.change.added.map((entry) => (
              <span key={`+${entry.line}`} className="block truncate">
                + {bare(entry)}
              </span>
            ))}
          </span>
        ) : null}
      </button>
      <span className="shrink-0 py-1.5 text-xs text-muted-foreground group-focus-within:hidden group-hover:hidden">
        {time}
      </span>
      {row.undoable ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="mt-1 hidden group-focus-within:inline-flex group-hover:inline-flex"
          onClick={onUndo}
        >
          <Undo2 />
          {t('settings.bots.memoryHistory.undoAction', 'Undo')}
        </Button>
      ) : null}
    </li>
  )
}

/** Every change to MEMORY.md, newest first, each with Undo. */
export function BotMemoryHistory({
  load,
  undo,
  version,
  onChanged
}: {
  load: () => Promise<BotMemoryHistoryView[]>
  undo: (id: string) => Promise<boolean>
  /** Reloads when it changes: the file as last read. */
  version: string
  onChanged: () => Promise<void>
}): React.JSX.Element | null {
  const t = useTranslate()
  // Days are named as of the load.
  const [loaded, setLoaded] = useState<{ rows: BotMemoryHistoryView[]; now: Date } | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    load()
      .then((rows) => current && setLoaded({ rows, now: new Date() }))
      .catch((error: unknown) => current && toast.error(botErrorMessage(error)))
    return () => {
      current = false
    }
  }, [load, version])

  const undoRow = async (id: string): Promise<void> => {
    try {
      if (!(await undo(id))) {
        toast(
          t(
            'settings.bots.memoryHistory.nothingToUndo',
            'Nothing left to undo: those lines changed since.'
          )
        )
      }
    } catch (error) {
      toast.error(botErrorMessage(error))
    }
    await onChanged()
  }

  if (loaded === null) {
    return null
  }
  const { rows, now } = loaded
  if (rows.length === 0) {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        {t('settings.bots.memoryHistory.empty', 'No changes yet.')}
      </p>
    )
  }
  return (
    <ul className="space-y-0.5">
      {rows.flatMap((row, index) => {
        const day = dayLabel(row.at, now)
        const item = (
          <Row
            key={row.id}
            row={row}
            open={open === row.id}
            onToggle={() => setOpen(open === row.id ? null : row.id)}
            onUndo={() => void undoRow(row.id)}
          />
        )
        return index > 0 && dayLabel(rows[index - 1].at, now) === day
          ? [item]
          : [
              <li key={`day:${row.id}`} className="px-2 pt-2 pb-0.5 text-xs text-muted-foreground">
                {day}
              </li>,
              item
            ]
      })}
    </ul>
  )
}
