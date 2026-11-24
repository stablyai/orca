import { useEffect, useState } from 'react'
import { ChevronRight, Minus, Pencil, Plus, RotateCcw, Sparkles, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SettingsInsetGroup } from '@/components/bots/settings-view/BotSettingsRows'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { botErrorMessage } from '@/components/bots/bot-presentation'
import { cn } from '@/lib/class-names'
import type { BotMemoryHistoryView } from '../../../../../shared/bots/bot-memory-history'
import {
  botMemoryHistoryAuthor,
  botMemoryHistoryKind,
  botMemoryHistoryLine,
  botMemoryHistorySummary,
  type BotMemoryHistoryKind
} from '../../../../../shared/bots/bot-memory-history-copy'

const DAY_MS = 24 * 60 * 60 * 1000

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

const ROW_ICONS: Record<BotMemoryHistoryKind, React.JSX.Element> = {
  'tidy-up': <Sparkles className="size-2.5" />,
  undo: <RotateCcw className="size-2.5" />,
  edit: <Pencil className="size-2.5" />,
  forget: <Minus className="size-2.5" />,
  add: <Plus className="size-2.5" />
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
  const subtitle = botMemoryHistoryAuthor(translate, row)
  return (
    <div data-row-icon="" className="px-3 py-2.5 transition-colors hover:bg-accent/40">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-start gap-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onToggle}
      >
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded bg-foreground/[0.07] text-muted-foreground">
          {ROW_ICONS[botMemoryHistoryKind(row)]}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] leading-[18px] text-foreground">
            {botMemoryHistorySummary(translate, row)}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{subtitle}</span>
            <span className="shrink-0 tabular-nums">{time}</span>
          </span>
        </span>
        <ChevronRight
          className={cn(
            'mt-1 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150',
            open ? 'rotate-90' : null
          )}
        />
      </button>
      {open ? (
        <div className="mt-2.5 ml-6.5 space-y-2">
          <div className="space-y-1 rounded-md bg-foreground/[0.045] p-2 font-mono text-2xs leading-[17px] dark:bg-background/50">
            {row.change.removed.map((entry) => (
              <div
                key={`-${entry.line}`}
                className="flex gap-1.5 break-words text-muted-foreground"
              >
                <span className="shrink-0 select-none">−</span>
                <span className="min-w-0">{botMemoryHistoryLine(entry)}</span>
              </div>
            ))}
            {row.change.added.map((entry) => (
              <div key={`+${entry.line}`} className="flex gap-1.5 break-words text-foreground">
                <span className="shrink-0 select-none">+</span>
                <span className="min-w-0">{botMemoryHistoryLine(entry)}</span>
              </div>
            ))}
          </div>
          {row.undoable ? (
            <div className="flex justify-end">
              <Button type="button" size="xs" variant="ghost" onClick={onUndo}>
                <Undo2 />
                {t('settings.bots.memoryHistory.undoAction', 'Undo')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Every change to MEMORY.md, newest first, grouped by day inside inset cards. */
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

  const groups: { day: string; rows: BotMemoryHistoryView[] }[] = []
  for (const row of rows) {
    const day = dayLabel(row.at, now)
    const last = groups.at(-1)
    if (last && last.day === day) {
      last.rows.push(row)
    } else {
      groups.push({ day, rows: [row] })
    }
  }

  return (
    <div className="flex flex-col gap-3.5">
      {groups.map((group) => (
        <SettingsInsetGroup key={group.day} title={group.day}>
          {group.rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              open={open === row.id}
              onToggle={() => setOpen(open === row.id ? null : row.id)}
              onUndo={() => void undoRow(row.id)}
            />
          ))}
        </SettingsInsetGroup>
      ))}
    </div>
  )
}
