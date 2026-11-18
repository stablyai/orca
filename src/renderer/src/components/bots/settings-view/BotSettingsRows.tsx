// The settings view's inset groups and rows: a muted card of rows under a small heading, with an optional foot line.
import { createContext, useContext } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/class-names'
import type { BotSettingsPage } from './bot-settings-place'

/** True while the bot's host is unreachable: rows still open their subpage; their end controls are off. */
export const SettingsControlsOffContext = createContext(false)

// Hairlines between rows start at the text, under an icon only when both rows have one.
const INSET_GROUP = cn(
  'overflow-hidden rounded-[10px] bg-foreground/[0.035]',
  '[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:top-0',
  "[&>*+*]:before:right-0 [&>*+*]:before:left-3 [&>*+*]:before:border-t [&>*+*]:before:border-border [&>*+*]:before:content-['']",
  '[&>[data-row-icon]+[data-row-icon]]:before:left-[38px]'
)

export function SettingsInsetGroup({
  title,
  action,
  foot,
  children,
  className
}: {
  title?: React.ReactNode
  /** At the heading's end, such as Add. */
  action?: React.ReactNode
  foot?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <section className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {title || action ? (
        <div className="flex min-h-5 items-center gap-1.5 px-3">
          <h3 className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {title}
          </h3>
          {action}
        </div>
      ) : null}
      <div className={INSET_GROUP}>{children}</div>
      {foot ? <p className="px-3 text-xs leading-[17px] text-muted-foreground">{foot}</p> : null}
    </section>
  )
}

type SettingsInsetRowProps = {
  icon?: React.ReactNode
  title: React.ReactNode
  detail?: React.ReactNode
  /** The second line wraps instead of truncating, for descriptions. */
  wrapDetail?: boolean
  /** A control at the row's end (a switch, a button). Without one, `onOpen` draws a chevron. */
  end?: React.ReactNode
  onOpen?: () => void
  /** The subpage it opens, so Back returns focus here. */
  page?: BotSettingsPage
  /** Wraps the end control under the text when the host is narrow. */
  wrapEnd?: boolean
  muted?: boolean
  className?: string
}

const ROW =
  'flex min-h-11 w-full min-w-0 items-center gap-2.5 py-2 pr-2.5 pl-3 text-left text-[13px] outline-none'

function RowText({
  icon,
  title,
  detail,
  wrapDetail,
  muted
}: Pick<
  SettingsInsetRowProps,
  'icon' | 'title' | 'detail' | 'wrapDetail' | 'muted'
>): React.JSX.Element {
  return (
    <>
      {icon ? (
        <span
          className={cn(
            'flex w-4 shrink-0 justify-center text-muted-foreground [&_svg]:size-4',
            detail ? 'self-start pt-px' : null
          )}
        >
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate font-medium leading-[18px]',
            muted ? 'text-muted-foreground' : null
          )}
        >
          {title}
        </span>
        {detail ? (
          <span
            className={cn(
              'block text-xs leading-4 text-muted-foreground',
              wrapDetail ? 'break-words' : 'truncate'
            )}
          >
            {detail}
          </span>
        ) : null}
      </span>
    </>
  )
}

/** One row: opens a subpage when it has `onOpen` and no `end`; otherwise holds its control. */
export function SettingsInsetRow({
  end,
  onOpen,
  page,
  wrapEnd,
  className,
  ...text
}: SettingsInsetRowProps): React.JSX.Element {
  const controlsOff = useContext(SettingsControlsOffContext)
  if (onOpen && end === undefined) {
    return (
      <button
        type="button"
        data-settings-page={page}
        data-row-icon={text.icon ? '' : undefined}
        onClick={onOpen}
        className={cn(
          ROW,
          'transition-colors hover:bg-accent/60 focus-visible:bg-accent/60',
          className
        )}
      >
        <RowText {...text} />
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
    )
  }
  return (
    <div
      data-row-icon={text.icon ? '' : undefined}
      className={cn(
        ROW,
        wrapEnd ? '@max-[300px]/settings-view:flex-wrap' : null,
        onOpen ? 'transition-colors has-[>button:hover]:bg-accent/60' : null,
        className
      )}
    >
      {onOpen ? (
        // The text opens the subpage; the control at the end acts on its own.
        <button
          type="button"
          data-settings-page={page}
          onClick={onOpen}
          className="-my-2 -ml-3 flex min-w-0 flex-1 items-center gap-2.5 self-stretch py-2 pl-3 text-left outline-none focus-visible:bg-accent/60"
        >
          <RowText {...text} />
        </button>
      ) : (
        <RowText {...text} />
      )}
      {end ? (
        <fieldset
          disabled={controlsOff}
          className={cn(
            'flex shrink-0 items-center gap-1.5',
            wrapEnd
              ? '@max-[300px]/settings-view:basis-full @max-[300px]/settings-view:pl-6.5'
              : null
          )}
        >
          {end}
        </fieldset>
      ) : null}
    </div>
  )
}
