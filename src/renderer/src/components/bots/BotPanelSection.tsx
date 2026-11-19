// One section of a bot's right panel: the left sidebar's header anatomy (chevron left, the whole header
// folds it) over flush rows. Idle header actions show on hover or keyboard focus; live ones always show.
import { useId } from 'react'
import { cn } from '@/lib/class-names'
import { SidebarSectionFoldChevron } from '../sidebar/sidebar-section-fold'
import type { BotPanelFold } from './use-bot-panel-fold'

export function BotPanelSectionHeader({
  title,
  fold,
  bodyId,
  summary,
  actions,
  live
}: {
  title: string
  fold?: BotPanelFold
  bodyId?: string
  /** Quiet text after the title, such as a folded group's count. */
  summary?: React.ReactNode
  /** Idle controls at the end, shown on hover or focus. */
  actions?: React.ReactNode
  /** Controls at the end that always show, such as a live spinner. */
  live?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="group/section relative flex h-7 min-w-0 items-center gap-1 pr-1 pl-1">
      {fold ? (
        <button
          type="button"
          aria-label={title}
          aria-expanded={fold.open}
          aria-controls={bodyId}
          className="peer absolute inset-0 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={(event) => {
            fold.onOpenChange(!fold.open)
            // A clicked header must not keep focus (and its revealed actions) once the pointer leaves.
            if (event.detail > 0) {
              event.currentTarget.blur()
            }
          }}
        />
      ) : null}
      {fold ? <SidebarSectionFoldChevron collapsed={!fold.open} /> : null}
      <h3
        className={cn(
          'pointer-events-none min-w-0 truncate text-xs font-semibold text-muted-foreground/80 select-none',
          !fold && 'pl-[22px]'
        )}
      >
        {title}
      </h3>
      {summary ? (
        <span className="pointer-events-none shrink-0 text-xs text-muted-foreground tabular-nums">
          {summary}
        </span>
      ) : null}
      {actions || live ? (
        <span className="relative ml-auto flex shrink-0 items-center gap-0.5">
          {actions ? (
            <span className="invisible flex items-center gap-0.5 group-hover/section:visible group-focus-within/section:visible">
              {actions}
            </span>
          ) : null}
          {live}
        </span>
      ) : null}
    </div>
  )
}

export function BotPanelSection({
  title,
  fold,
  summary,
  actions,
  live,
  folded,
  className,
  ref,
  children
}: {
  title: string
  fold?: BotPanelFold
  summary?: React.ReactNode
  actions?: React.ReactNode
  live?: React.ReactNode
  /** What stays listed under the header while folded. */
  folded?: React.ReactNode
  className?: string
  ref?: React.Ref<HTMLElement>
  children: React.ReactNode
}): React.JSX.Element {
  const bodyId = useId()
  const open = fold?.open ?? true
  return (
    <section ref={ref} className={cn('flex flex-col gap-0.5', className)}>
      <BotPanelSectionHeader
        title={title}
        fold={fold}
        bodyId={bodyId}
        summary={summary}
        actions={actions}
        live={live}
      />
      {open ? (
        <div id={bodyId} className="flex flex-col">
          {children}
        </div>
      ) : folded ? (
        <div className="flex flex-col">{folded}</div>
      ) : null}
    </section>
  )
}
