import React from 'react'
import { Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

const TIME_SHELL_CLASS =
  'flex h-9 w-full items-center gap-2 rounded-md border border-input bg-input/30 px-3 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30'

export type AutomationClockParts = {
  hour12: number
  minute: number
  period: 'AM' | 'PM'
}

export function parseAutomationTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map((part) => Number(part))
  return {
    hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 9,
    minute: Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0
  }
}

export function formatAutomationTimeInput(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function getAutomationClockParts(time: string): AutomationClockParts {
  const { hour, minute } = parseAutomationTime(time)
  return {
    hour12: hour % 12 === 0 ? 12 : hour % 12,
    minute,
    period: hour >= 12 ? 'PM' : 'AM'
  }
}

export function formatAutomationTimeFromClockParts(parts: AutomationClockParts): string {
  const hour24 =
    parts.period === 'AM'
      ? parts.hour12 === 12
        ? 0
        : parts.hour12
      : parts.hour12 === 12
        ? 12
        : parts.hour12 + 12
  return formatAutomationTimeInput(hour24, parts.minute)
}

export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Resolve typed digits on commit. Empty → min (0 minutes / 1 hour). */
export function resolveDigitCommit(raw: string, value: number, min: number, max: number): number {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return min
  }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) {
    return value
  }
  return clampInt(parsed, min, max)
}

/** Step from in-progress text when present, otherwise the committed value. */
export function resolveDigitStep(
  raw: string,
  value: number,
  min: number,
  max: number,
  delta: 1 | -1
): number {
  const trimmed = raw.trim()
  const parsed = trimmed === '' ? Number.NaN : Number(trimmed)
  const base = Number.isFinite(parsed) ? clampInt(parsed, min, max) : value
  if (delta === 1) {
    return base >= max ? min : base + 1
  }
  return base <= min ? max : base - 1
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function TimeDigitInput({
  value,
  min,
  max,
  pad = true,
  ariaLabel,
  onCommit
}: {
  value: number
  min: number
  max: number
  pad?: boolean
  ariaLabel: string
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [text, setText] = React.useState(pad ? pad2(value) : String(value))
  const [focused, setFocused] = React.useState(false)
  // Track last emitted commit so blur after 2-digit auto-commit does not re-fire.
  const lastCommittedRef = React.useRef(value)

  // Keep the visible digits in sync while the field is not being edited.
  React.useEffect(() => {
    lastCommittedRef.current = value
    if (!focused) {
      setText(pad ? pad2(value) : String(value))
    }
  }, [focused, pad, value])

  const commit = (raw: string): void => {
    const next = resolveDigitCommit(raw, value, min, max)
    setText(pad ? pad2(next) : String(next))
    if (next === lastCommittedRef.current) {
      return
    }
    lastCommittedRef.current = next
    onCommit(next)
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      aria-label={ariaLabel}
      value={text}
      onFocus={(event) => {
        setFocused(true)
        event.currentTarget.select()
      }}
      onBlur={() => {
        setFocused(false)
        commit(text)
      }}
      onChange={(event) => {
        const next = event.target.value.replace(/\D/g, '').slice(0, 2)
        setText(next)
        if (next.length === 2) {
          commit(next)
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          const next = resolveDigitStep(text, value, min, max, event.key === 'ArrowUp' ? 1 : -1)
          setText(pad ? pad2(next) : String(next))
          if (next !== lastCommittedRef.current) {
            lastCommittedRef.current = next
            onCommit(next)
          }
          return
        }
        if (event.key === 'Enter') {
          event.currentTarget.blur()
        }
      }}
      className="h-7 w-9 rounded-sm border-0 bg-transparent p-0 text-center text-sm tabular-nums tracking-wide text-foreground outline-none selection:bg-primary/20 focus-visible:bg-accent/50"
    />
  )
}

export function AutomationTimeField({
  time,
  mode = 'time',
  onTimeChange,
  className
}: {
  time: string
  mode?: 'time' | 'minute'
  onTimeChange: (time: string) => void
  className?: string
}): React.JSX.Element {
  const clock = getAutomationClockParts(time)
  // Why: digit commits close over the latest clock parts without stale hour/minute.
  // Sync in an effect so render stays pure (React Doctor: no ref writes during render).
  const clockRef = React.useRef(clock)
  React.useEffect(() => {
    clockRef.current = getAutomationClockParts(time)
  }, [time])

  const patchTime = (patch: Partial<AutomationClockParts>): void => {
    // Why: apply the patch to the ref immediately so a second digit field commit
    // in the same tick (or before the parent re-renders) cannot clobber the first.
    const next = { ...clockRef.current, ...patch }
    clockRef.current = next
    onTimeChange(formatAutomationTimeFromClockParts(next))
  }

  return (
    <div className={cn(TIME_SHELL_CLASS, className)}>
      <Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {mode === 'time' ? (
          <>
            <TimeDigitInput
              value={clock.hour12}
              min={1}
              max={12}
              pad={false}
              ariaLabel={translate(
                'auto.components.automations.AutomationTimeField.aa593eb5e2',
                'Hour'
              )}
              onCommit={(hour12) => patchTime({ hour12 })}
            />
            <span className="select-none text-sm text-muted-foreground" aria-hidden>
              :
            </span>
            <TimeDigitInput
              value={clock.minute}
              min={0}
              max={59}
              ariaLabel={translate(
                'auto.components.automations.AutomationTimeField.32a5e4e35e',
                'Minute'
              )}
              onCommit={(minute) => patchTime({ minute })}
            />
            <button
              type="button"
              // The label overrides the visible text, so name the current period explicitly.
              aria-label={`${translate(
                'auto.components.automations.AutomationTimeField.39ec1383f6',
                'AM or PM'
              )}: ${clock.period}`}
              aria-pressed={clock.period === 'PM'}
              onClick={() => patchTime({ period: clock.period === 'AM' ? 'PM' : 'AM' })}
              className="ml-auto h-7 shrink-0 rounded-sm px-2 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 focus-visible:text-foreground"
            >
              {clock.period}
            </button>
          </>
        ) : (
          <>
            <span className="select-none text-sm text-muted-foreground" aria-hidden>
              :
            </span>
            <TimeDigitInput
              value={clock.minute}
              min={0}
              max={59}
              ariaLabel={translate(
                'auto.components.automations.AutomationTimeField.32a5e4e35e',
                'Minute'
              )}
              onCommit={(minute) => patchTime({ minute })}
            />
          </>
        )}
      </div>
    </div>
  )
}
