// Custom times for Look around: one time field per row, + Add time, saved only when the whole list is
// valid. Rows keep the order they were typed in while the list has focus; they sort once it saves.
import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import { AutomationTimeField } from '@/components/automations/authoring/AutomationTimeField'
import { Button } from '@/components/ui/button'
import { lookTimeLabel } from '@/components/bots/bot-look-around-copy'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import {
  LOOK_AROUND_MAX_TIMES,
  LOOK_AROUND_MIN_GAP_MINUTES
} from '../../../../../shared/bots/bot-look-around'
import { lookAroundTimesProblem } from '../../../../../shared/bots/bot-look-around-times'

type Row = { key: number; time: string }

/** A key no current row has, so React never reuses a removed row's field for a new one. */
function nextRowKey(rows: readonly Row[]): number {
  return Math.max(-1, ...rows.map((row) => row.key)) + 1
}

function sameTimes(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length && [...a].sort().every((time, index) => time === [...b].sort()[index])
  )
}

/** The first whole hour after the last time that keeps an hour from every other, else 9:00. */
function nextFreeTime(times: readonly string[]): string {
  const taken = times.map((time) => {
    const [hour = 0, minute = 0] = time.split(':').map(Number)
    return hour * 60 + minute
  })
  const last = Math.max(...taken, 8 * 60)
  for (let step = 1; step <= 24; step += 1) {
    const candidate = ((Math.floor(last / 60) + step) % 24) * 60
    const clear = taken.every((minutes) => {
      const gap = Math.abs(minutes - candidate)
      return Math.min(gap, 24 * 60 - gap) >= LOOK_AROUND_MIN_GAP_MINUTES
    })
    if (clear) {
      return `${String(candidate / 60).padStart(2, '0')}:00`
    }
  }
  return '09:00'
}

/** What's wrong with the list, in words, and which times it names. */
export function lookTimesError(times: readonly string[]): { text: string; bad: string[] } | null {
  const found = lookAroundTimesProblem(times)
  if (!found) {
    return null
  }
  const [a = '', b = ''] = found.times ?? []
  switch (found.problem) {
    case 'tooClose':
      return {
        text: translate(
          'settings.bots.lookAround.timesTooClose',
          'Looks need at least an hour between them ({{first}} and {{second}}).',
          { first: lookTimeLabel(a), second: lookTimeLabel(b) }
        ),
        bad: [a, b]
      }
    case 'duplicate':
      return {
        text: translate('settings.bots.lookAround.timesRepeated', '{{time}} is listed twice.', {
          time: lookTimeLabel(a)
        }),
        bad: [a]
      }
    case 'tooMany':
      return {
        text: translate('settings.bots.lookAround.timesTooMany', 'At most {{count}} looks a day.', {
          count: LOOK_AROUND_MAX_TIMES
        }),
        bad: []
      }
    case 'empty':
    case 'invalid':
      return {
        text: translate('settings.bots.lookAround.timesMissing', 'Add at least one time.'),
        bad: []
      }
  }
}

export function BotLookAroundTimes({
  saved,
  initialDraft,
  onSave,
  onDraftChange
}: {
  saved: readonly string[]
  initialDraft?: readonly string[] | null
  /** A valid list, sorted by the host on save. */
  onSave: (times: string[]) => void
  /** The unsaved list, or null when it matches what's saved; for Next look's "not saved" and
   *  saving on close. */
  onDraftChange: (draft: string[] | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [rows, setRows] = useState<Row[]>(() =>
    (initialDraft ?? saved).map((time, key) => ({ key, time }))
  )
  const pendingRows = useRef<Row[] | null>(null)
  const [lastSaved, setLastSaved] = useState(saved)
  const [focused, setFocused] = useState(false)
  if (!sameTimes(saved, lastSaved)) {
    // Saved elsewhere (the bot, asked in chat), or our own save sorted: follow it unless editing.
    setLastSaved(saved)
    if (!focused) {
      const base = nextRowKey(rows)
      setRows(saved.map((time, index) => ({ key: base + index, time })))
    }
  }
  const times = rows.map((row) => row.time)
  const error = lookTimesError(times)

  const commit = (next: Row[]): void => {
    const list = next.map((row) => row.time)
    const unsaved = !sameTimes(list, saved)
    onDraftChange(unsaved ? list : null)
    if (unsaved && !lookAroundTimesProblem(list)) {
      onSave(list)
    }
  }
  const draft = (next: Row[]): void => {
    pendingRows.current = next
    const list = next.map((row) => row.time)
    onDraftChange(sameTimes(list, saved) ? null : list)
  }
  const change = (next: Row[], save: boolean): void => {
    draft(next)
    setRows(next)
    if (save) {
      commit(next)
    }
  }

  return (
    <div
      className="space-y-2 pb-3"
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) {
          return
        }
        setFocused(false)
        // A child's one-digit commit happens in this same bubbling blur event.
        commit(pendingRows.current ?? rows)
        pendingRows.current = null
      }}
    >
      <ul className="space-y-2" aria-label={t('settings.bots.lookAround.times', 'Look times')}>
        {rows.map((row, index) => (
          <li
            key={row.key}
            role="group"
            aria-label={t(
              'settings.bots.lookAround.timeLabel',
              'Look time {{index}} of {{count}}',
              {
                index: index + 1,
                count: rows.length
              }
            )}
            className="flex items-center gap-2"
          >
            <AutomationTimeField
              time={row.time}
              className={cn(
                'w-44',
                error?.bad.includes(row.time) &&
                  'border-destructive focus-within:border-destructive'
              )}
              onTimeChange={(time) =>
                change(
                  (pendingRows.current ?? rows).map((entry) =>
                    entry.key === row.key ? { ...entry, time } : entry
                  ),
                  false
                )
              }
              onDraftTimeChange={(time) =>
                draft(
                  (pendingRows.current ?? rows).map((entry) =>
                    entry.key === row.key ? { ...entry, time } : entry
                  )
                )
              }
            />
            {rows.length > 1 ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('settings.bots.lookAround.removeTime', 'Remove {{time}}', {
                  time: lookTimeLabel(row.time)
                })}
                onClick={() =>
                  change(
                    (pendingRows.current ?? rows).filter((entry) => entry.key !== row.key),
                    true
                  )
                }
              >
                <X />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error.text}{' '}
          {t(
            'settings.bots.lookAround.timesNotSaved',
            'Not saved until it’s fixed; leaving keeps your saved times.'
          )}
        </p>
      ) : null}
      {rows.length === 1 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.bots.lookAround.oneTimeNeeded',
            'A schedule needs at least one time. To stop looking, turn Look around off above.'
          )}
        </p>
      ) : null}
      {rows.length < LOOK_AROUND_MAX_TIMES ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const current = pendingRows.current ?? rows
            change(
              [
                ...current,
                { key: nextRowKey(current), time: nextFreeTime(current.map((row) => row.time)) }
              ],
              true
            )
          }}
        >
          {t('settings.bots.lookAround.addTime', '+ Add time')}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('settings.bots.lookAround.maxTimes', 'Up to {{count}} looks a day.', {
            count: LOOK_AROUND_MAX_TIMES
          })}
        </p>
      )}
    </div>
  )
}
