// Picking bots in a dialog, in rows like the sidebar's: a picked one takes the sidebar's selected look and a
// check that pops in. A filter shows once the list no longer fits at a glance. New group and Import use it.
import React, { useEffect, useRef } from 'react'
import { Check, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { readPrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

// A filter appears once the list no longer fits at a glance.
export const FILTER_FROM = 10

/** Rows whose name has the filter text, ignoring case. */
export function filterByName<T>(
  items: readonly T[],
  query: string,
  name: (item: T) => string
): T[] {
  const needle = query.trim().toLowerCase()
  return needle ? items.filter((item) => name(item).toLowerCase().includes(needle)) : [...items]
}

export function BotPickFilter({
  value,
  onChange,
  compact
}: {
  value: string
  onChange: (value: string) => void
  compact?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className={compact ? 'relative shrink-0' : 'relative mb-2'}>
      <Search
        className={cn(
          'pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground',
          compact ? 'left-4.5 size-4' : 'left-2.5 size-3'
        )}
      />
      <Input
        density="compact"
        inset="leadingIcon"
        className={compact ? 'h-8.5 pl-[45px]' : undefined}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('bots.groups.filter', 'Filter bots')}
        aria-label={t('bots.groups.filter', 'Filter bots')}
        autoComplete="off"
      />
    </div>
  )
}

/** The rows' scrolling box. */
export function BotPickRows({
  role,
  labelledBy,
  compact,
  children
}: {
  /** Unset when a RadioGroup inside carries the role. */
  role?: 'group'
  labelledBy?: string
  compact?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role={role}
      aria-labelledby={labelledBy}
      className={cn(
        'scrollbar-sleek flex flex-col overflow-y-auto',
        compact
          ? 'min-h-0 max-h-58 rounded-md border border-border p-1'
          : '-mx-1.5 max-h-75 gap-0.5 px-1.5 py-0.5'
      )}
    >
      {children}
    </div>
  )
}

export const BOT_PICK_POP_EASING = 'cubic-bezier(0.34, 1.56, 0.64, 1)'

/** Pops `el` in, as New group's faces and checks do. */
export function popIn(el: HTMLElement | null, duration = 320): void {
  if (el && !readPrefersReducedMotion()) {
    el.animate(
      [
        { transform: 'scale(0.4)', opacity: 0 },
        { transform: 'scale(1)', opacity: 1 }
      ],
      { duration, easing: BOT_PICK_POP_EASING }
    )
  }
}

export function BotPickRow({
  picture,
  name,
  detail,
  on,
  pop,
  indicator = 'badge',
  trailing,
  ...button
}: {
  picture: React.ReactNode
  name: string
  detail?: string | null
  /** Picked: the selected look and the check. */
  on: boolean
  /** Pop the check in: it was just picked. */
  pop?: boolean
  indicator?: 'badge' | 'checkbox'
  trailing?: React.ReactNode
} & Omit<React.ComponentPropsWithRef<'button'>, 'type' | 'className'>): React.JSX.Element {
  const check = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (pop) {
      popIn(check.current)
    }
  }, [pop])
  return (
    <button
      type="button"
      {...button}
      data-worktree-card-surface={indicator === 'badge' ? '' : undefined}
      data-worktree-card-selected={indicator === 'badge' && on ? '' : undefined}
      className={cn(
        'flex w-full items-center border border-transparent px-2 text-left outline-none transition-[background-color,border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50',
        indicator === 'checkbox'
          ? 'h-11 shrink-0 gap-2 rounded-md hover:bg-accent focus-visible:ring-inset aria-checked:bg-accent'
          : 'worktree-sidebar-card-hover gap-2.5 rounded-lg py-1.5'
      )}
    >
      <span className="relative shrink-0">
        {picture}
        {on && indicator === 'badge' ? (
          <span
            ref={check}
            className="absolute -right-1.5 -bottom-1.5 flex size-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground"
            style={{ boxShadow: '0 0 0 2px var(--dialog-surface)' }}
          >
            <Check className="size-2.5" strokeWidth={3} />
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] leading-5">{name}</span>
        {detail ? (
          <span className="truncate text-xs leading-4 text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {trailing}
      {indicator === 'checkbox' ? (
        <span
          aria-hidden
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-sm border',
            on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/60'
          )}
        >
          {on ? (
            <span ref={check}>
              <Check className="size-3" />
            </span>
          ) : null}
        </span>
      ) : null}
    </button>
  )
}
