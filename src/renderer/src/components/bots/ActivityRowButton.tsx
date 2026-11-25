import type { ComponentPropsWithRef, ReactNode } from 'react'
import { cn } from '@/lib/class-names'

export type ActivityRowButtonProps = Omit<ComponentPropsWithRef<'button'>, 'title'> & {
  icon: ReactNode
  title: ReactNode
  /** Right of the title: time, state. */
  meta?: ReactNode
  metaClassName?: string
  /** Line 2. */
  detail?: ReactNode
  /** Nested under its chat or item: a lighter title, quieter once settled. */
  nested?: { settled: boolean }
}

/** The bot panel's activity row: an icon column, then title (with meta) over line 2. Every row in a list
 *  shares these columns, so workers, PRs and links line up. */
export function ActivityRowButton({
  icon,
  title,
  meta,
  metaClassName,
  detail,
  nested,
  className,
  ...button
}: ActivityRowButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left enabled:cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:hover:bg-transparent',
        nested && '@max-[240px]:gap-1.5 @max-[240px]:px-1',
        className
      )}
      {...button}
    >
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px] font-medium text-foreground',
              nested && 'text-xs font-normal',
              nested?.settled && 'text-foreground/70'
            )}
          >
            {title}
          </span>
          {meta !== undefined && meta !== null ? (
            <span
              className={cn('shrink-0 text-2xs tabular-nums text-muted-foreground', metaClassName)}
            >
              {meta}
            </span>
          ) : null}
        </span>
        {detail}
      </span>
    </button>
  )
}
