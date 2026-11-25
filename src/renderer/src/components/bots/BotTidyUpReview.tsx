// "Last night's tidy-up": what a tidy-up changed, with Undo for the whole run (its one History row).
import { useRef } from 'react'
import { Undo2 } from 'lucide-react'
import { formatAutomationDateTime } from '@/components/automations/automation-page-parts'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { BotTidyUpView } from '../../../../shared/bots/bot-tidy-up'

type TidyUpRun = NonNullable<BotTidyUpView['last']>

/** "Today, 3:12 AM · read 4 chats · took 2 min". */
export function tidyUpRunMeta(run: TidyUpRun, withChats = true): string {
  const minutes = Math.max(1, Math.round(run.tookMs / 60_000))
  return [
    formatAutomationDateTime(run.at),
    ...(withChats
      ? [translate('settings.bots.tidyUp.readChats', 'read {{count}} chats', { count: run.chats })]
      : []),
    translate('settings.bots.tidyUp.took', 'took {{value}} min', { value: minutes })
  ].join(' · ')
}

/** Each tidying change, as one line. */
function tidiedLines(run: TidyUpRun): string[] {
  return [
    ...(run.merged > 0
      ? [
          translate('settings.bots.tidyUp.merged', 'Merged {{count}} repeated lines', {
            count: run.merged
          })
        ]
      : []),
    ...run.replaced.map((fact) =>
      translate('settings.bots.tidyUp.replaced', 'Marked replaced: {{fact}}', { fact })
    ),
    ...run.filed.map(({ topic, count }) =>
      translate('settings.bots.tidyUp.filed', 'Filed {{count}} lines into memory/{{topic}}.md', {
        count,
        topic
      })
    ),
    ...(run.moved > 0
      ? [
          translate(
            'settings.bots.tidyUp.moved',
            'Moved {{count}} old lines to memory/archive.md',
            {
              count: run.moved
            }
          )
        ]
      : [])
  ]
}

function Group({ title, lines }: { title: string; lines: string[] }): React.JSX.Element | null {
  if (lines.length === 0) {
    return null
  }
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{title}</p>
      <ul className="space-y-1.5">
        {lines.map((line) => (
          <li key={line} className="text-sm text-foreground">
            {line}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function BotTidyUpReview({
  run,
  open,
  onOpenChange,
  onUndo,
  onOpenHistory
}: {
  run: TidyUpRun
  open: boolean
  onOpenChange: (open: boolean) => void
  onUndo: () => void
  /** Absent where History is already on screen. */
  onOpenHistory?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const done = useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        scrollable
        // Done, not Undo: opening the summary should never leave a whole-run Undo one key away.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          done.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {/* A nightly run reads as last night's; one from Tidy now during the day doesn't. */}
            {new Date(run.at).getHours() < 9
              ? t('settings.bots.tidyUp.reviewTitleNight', 'Last night’s tidy-up')
              : t('settings.bots.tidyUp.reviewTitle', 'Last tidy-up')}
          </DialogTitle>
          <DialogDescription>{tidyUpRunMeta(run)}</DialogDescription>
        </DialogHeader>
        <Group
          title={t('settings.bots.tidyUp.learned', 'Learned from chats')}
          lines={run.learned}
        />
        <Group title={t('settings.bots.tidyUp.tidied', 'Tidied')} lines={tidiedLines(run)} />
        <p className="text-xs text-muted-foreground">
          {run.undone
            ? t(
                'settings.bots.tidyUp.undone',
                'Undone: MEMORY.md is back as it was before this tidy-up.'
              )
            : t(
                'settings.bots.tidyUp.undoNote',
                'Undo puts MEMORY.md back as it was before this tidy-up, all at once. The copies in topic files and the archive stay.'
              )}
        </p>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            disabled={run.undone || run.rowId === null}
            onClick={onUndo}
          >
            <Undo2 />
            {t('settings.bots.tidyUp.undoAll', 'Undo tidy-up')}
          </Button>
          <div className="flex gap-2">
            {onOpenHistory ? (
              <Button variant="outline" size="sm" onClick={onOpenHistory}>
                {t('settings.bots.tidyUp.openHistory', 'Open history')}
              </Button>
            ) : null}
            <Button ref={done} size="sm" onClick={() => onOpenChange(false)}>
              {t('settings.bots.tidyUp.done', 'Done')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
