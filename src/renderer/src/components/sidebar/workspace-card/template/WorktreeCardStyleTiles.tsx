import { useRef } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { WorktreeCardsIntroChoice } from '@/store/slices/ui/ui-slice-contract-contextual'

const BAR = 'block h-[5px] shrink-0 rounded-full bg-foreground/25'

function ClassicPicture(): React.JSX.Element {
  return (
    <>
      {[0, 1, 2].map((row) => (
        <span key={row} className="flex items-center gap-1">
          <span className={cn(BAR, 'w-2')} />
          <span className={cn(BAR, 'w-[55%]')} />
          <span className={cn(BAR, 'ml-auto w-2.5')} />
        </span>
      ))}
    </>
  )
}

function NewPicture(): React.JSX.Element {
  return (
    <>
      <span className="flex items-center gap-1">
        <span className={cn(BAR, 'w-2')} />
        <span className={cn(BAR, 'w-[38%]')} />
        <span className="block h-1.5 w-3 shrink-0 rounded-[2px] bg-status-warning/70" />
        <span className={cn(BAR, 'ml-auto w-2.5')} />
      </span>
      <span className="flex items-center gap-1 pl-3">
        <span className={cn(BAR, 'w-[45%] opacity-70')} />
      </span>
      <span className="flex items-center gap-1">
        <span className="block size-[5px] shrink-0 rounded-full bg-unread" />
        <span className={cn(BAR, 'w-[44%]')} />
        <span className={cn(BAR, 'ml-auto w-2.5')} />
      </span>
    </>
  )
}

/** Picture tiles for the intro note: the whole tile is the radio, so hover and click cover all of it. */
export function WorktreeCardStyleTiles({
  value,
  disabled = false,
  onChange
}: {
  value: WorktreeCardsIntroChoice
  disabled?: boolean
  onChange: (value: WorktreeCardsIntroChoice) => void
}): React.JSX.Element {
  const t = useTranslate()
  const refs = useRef<Record<WorktreeCardsIntroChoice, HTMLButtonElement | null>>({
    classic: null,
    new: null
  })
  const options: { value: WorktreeCardsIntroChoice; label: string }[] = [
    { value: 'classic', label: t('sidebar.worktreeCardsIntroNotice.classic', 'Classic') },
    { value: 'new', label: t('sidebar.worktreeCardsIntroNotice.new', 'New') }
  ]
  const select = (next: WorktreeCardsIntroChoice): void => {
    onChange(next)
    refs.current[next]?.focus()
  }
  return (
    <div
      role="radiogroup"
      aria-label={t('sidebar.worktreeCardsIntroNotice.switchLabel', 'Card style')}
      className="grid grid-cols-2 gap-2.5"
      onKeyDown={(event) => {
        if (disabled) {
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault()
          select('classic')
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault()
          select('new')
        }
      }}
    >
      {options.map((option) => {
        const checked = option.value === value
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[option.value] = node
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-card-style-tile={option.value}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              // Why foreground/45: border-border is under 3:1 on the popover in both themes.
              'min-w-0 cursor-pointer rounded-[10px] border p-2 text-left outline-none transition-[background-color,border-color,box-shadow] duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover disabled:cursor-default disabled:opacity-60 motion-reduce:transition-none',
              checked
                ? 'border-foreground ring-1 ring-foreground enabled:hover:bg-accent/60'
                : 'border-foreground/45 enabled:hover:border-foreground/70 enabled:hover:bg-accent'
            )}
          >
            <span
              aria-hidden="true"
              className="flex h-[58px] flex-col gap-[5px] overflow-hidden rounded-md border border-border bg-background p-1.5"
            >
              {option.value === 'new' ? <NewPicture /> : <ClassicPicture />}
            </span>
            <span className="mt-2 flex items-center gap-[7px] text-[13px] font-semibold">
              <span
                aria-hidden="true"
                className={cn(
                  'grid size-3.5 shrink-0 place-items-center rounded-full border-[1.5px]',
                  checked ? 'border-foreground' : 'border-foreground/45'
                )}
              >
                {checked ? <span className="size-1.5 rounded-full bg-foreground" /> : null}
              </span>
              <span className="truncate">{option.label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
