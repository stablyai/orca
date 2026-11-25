import * as React from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { useTranslate } from '@/i18n/use-translate'

/** Days are local midnights; `min`/`max` bound what can be picked and reached. */
type MonthCalendarProps = {
  selected: Date
  onSelect: (day: Date) => void
  today: Date
  min?: Date
  max?: Date
  /** Focus the selected day on mount. */
  autoFocus?: boolean
  className?: string
}

const sameDay = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
const addDays = (day: Date, count: number): Date =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate() + count)
const monthStart = (day: Date): Date => new Date(day.getFullYear(), day.getMonth(), 1)
const dayKey = (day: Date): string => `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`

/** Moves by whole months, keeping the day of month where the target month has it. */
function addMonths(day: Date, count: number): Date {
  const target = new Date(day.getFullYear(), day.getMonth() + count, 1)
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return new Date(target.getFullYear(), target.getMonth(), Math.min(day.getDate(), last))
}

function clamp(day: Date, min?: Date, max?: Date): Date {
  if (min && day < min) {
    return min
  }
  return max && day > max ? max : day
}

/** Weeks of the month starting Sunday, `null` where a cell falls outside it. */
function monthWeeks(month: Date): (Date | null)[][] {
  const cells: (Date | null)[] = Array.from({ length: month.getDay() }, () => null)
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  for (let date = 1; date <= days; date++) {
    cells.push(new Date(month.getFullYear(), month.getMonth(), date))
  }
  while (cells.length % 7 !== 0) {
    cells.push(null)
  }
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7))
}

/** A month grid: arrows move a day or week, Home/End to the week's ends, Page Up/Down a month. */
export function MonthCalendar({
  selected,
  onSelect,
  today,
  min,
  max,
  autoFocus = false,
  className
}: MonthCalendarProps): React.JSX.Element {
  const t = useTranslate()
  const [focused, setFocused] = React.useState(selected)
  const [shown, setMonth] = React.useState(() => monthStart(selected))
  // Bounds can move while open (a day runs out), so never show a month before the first pickable one.
  const month = min && shown < monthStart(min) ? monthStart(min) : shown
  const grid = React.useRef<HTMLTableElement>(null)
  const moved = React.useRef(autoFocus)

  React.useEffect(() => {
    if (moved.current) {
      moved.current = false
      grid.current?.querySelector<HTMLButtonElement>(`[data-day="${dayKey(focused)}"]`)?.focus()
    }
  }, [focused])

  const focusDay = (day: Date): void => {
    const next = clamp(day, min, max)
    moved.current = true
    setFocused(next)
    setMonth(monthStart(next))
  }
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const step: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focused, -1),
      ArrowRight: () => addDays(focused, 1),
      ArrowUp: () => addDays(focused, -7),
      ArrowDown: () => addDays(focused, 7),
      Home: () => addDays(focused, -focused.getDay()),
      End: () => addDays(focused, 6 - focused.getDay()),
      PageUp: () => addMonths(focused, -1),
      PageDown: () => addMonths(focused, 1)
    }
    const next = step[event.key]
    if (next) {
      event.preventDefault()
      focusDay(next())
    }
  }
  const reachable = (day: Date): boolean =>
    day.getMonth() === month.getMonth() &&
    day.getFullYear() === month.getFullYear() &&
    sameDay(day, clamp(day, min, max))
  // Keep the tab stop on an enabled day this month shows.
  const tabStop = reachable(focused)
    ? focused
    : reachable(selected)
      ? selected
      : clamp(month, min, max)
  const caption = uiDateTimeFormat({ month: 'long', year: 'numeric' }).format(month)
  const narrow = uiDateTimeFormat({ weekday: 'narrow' })
  const long = uiDateTimeFormat({ weekday: 'long' })
  const fullDate = uiDateTimeFormat({ weekday: 'long', month: 'long', day: 'numeric' })
  const weekdays = Array.from({ length: 7 }, (_, index) => addDays(month, index - month.getDay()))

  return (
    <div data-slot="month-calendar" className={cn('w-full', className)}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium" aria-live="polite">
          {caption}
        </span>
        <div className="flex items-center">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('ui.monthCalendar.previous', 'Previous month')}
            disabled={min !== undefined && month <= monthStart(min)}
            onClick={() => setMonth(addMonths(month, -1))}
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('ui.monthCalendar.next', 'Next month')}
            disabled={max !== undefined && month >= monthStart(max)}
            onClick={() => setMonth(addMonths(month, 1))}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
      <table ref={grid} role="grid" aria-label={caption} className="flex w-full flex-col gap-1">
        {/* Flex rows, explicit roles: the first and last columns sit on the content edges. */}
        <thead className="flex">
          <tr role="row" className="flex w-full justify-between">
            {weekdays.map((day) => (
              <th
                key={day.getDay()}
                scope="col"
                role="columnheader"
                abbr={long.format(day)}
                className="flex size-8 items-center justify-center text-xs font-normal text-muted-foreground"
              >
                {narrow.format(day)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="flex flex-col gap-1" onKeyDown={onKeyDown}>
          {monthWeeks(month).map((week, row) => (
            <tr key={row} role="row" className="flex w-full justify-between">
              {week.map((day, column) => {
                if (!day) {
                  return <td key={column} role="gridcell" className="size-8" />
                }
                const isSelected = sameDay(day, selected)
                const isToday = sameDay(day, today)
                const outOfRange = (min && day < min) || (max && day > max)
                return (
                  <td
                    key={column}
                    role="gridcell"
                    className="size-8 p-0"
                    aria-selected={isSelected}
                  >
                    <button
                      type="button"
                      data-day={dayKey(day)}
                      tabIndex={sameDay(day, tabStop) ? 0 : -1}
                      disabled={outOfRange}
                      aria-label={fullDate.format(day)}
                      aria-current={isToday ? 'date' : undefined}
                      onFocus={() => setFocused(day)}
                      onClick={() => onSelect(day)}
                      className={cn(
                        'flex size-8 cursor-pointer items-center justify-center rounded-md text-sm tabular-nums outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:text-muted-foreground disabled:opacity-50',
                        isToday && !isSelected && 'ring-1 ring-muted-foreground/50 ring-inset',
                        isSelected &&
                          'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground'
                      )}
                    >
                      {day.getDate()}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
