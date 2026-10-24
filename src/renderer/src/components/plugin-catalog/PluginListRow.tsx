import { BadgeCheck } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { PluginRowArt } from './PluginRowArt'
import type { PluginListEntry } from './plugin-list-entries'

type PluginListRowProps = {
  entry: PluginListEntry
  /** Text the row's name button adds to its accessible name, such as the status word. */
  statusText?: string
  description: React.ReactNode
  descriptionTone?: 'default' | 'destructive'
  chips?: React.ReactNode
  dimmed?: boolean
  /** Inert rows (plugins off) show who is installed without offering anything. */
  inert?: boolean
  status?: React.ReactNode
  action?: React.ReactNode
  toggle?: React.ReactNode
  more?: React.ReactNode
  onOpen?: () => void
}

/**
 * One plugin: the name opens its page and its hit area covers the row; status, action, switch and
 * ⋯ are fixed-width sibling slots above it, so they line up down the list and stay in Tab order.
 */
export function PluginListRow({
  entry,
  statusText,
  description,
  descriptionTone = 'default',
  chips,
  dimmed = false,
  inert = false,
  status,
  action,
  toggle,
  more,
  onOpen
}: PluginListRowProps): React.JSX.Element {
  const accessibleName = [entry.name, entry.publisher, statusText].filter(Boolean).join(', ')
  return (
    <li
      className="plugin-list-row group/plugin-row relative grid min-h-15 grid-cols-[2rem_minmax(0,1fr)_auto_auto_2.5rem_1.75rem] items-center gap-x-3 border-t border-border py-2.5 pr-3 pl-4 first:border-t-0 hover:bg-accent/45 data-[inert=true]:pointer-events-none data-[inert=true]:hover:bg-transparent @max-xl/plugin-list:items-start"
      data-plugin-key={entry.pluginKey}
      data-dimmed={dimmed}
      data-inert={inert}
    >
      <div className="group-data-[dimmed=true]/plugin-row:opacity-55">
        <PluginRowArt entry={entry} />
      </div>
      <div className="min-w-0 group-data-[dimmed=true]/plugin-row:opacity-55">
        <div className="flex min-w-0 items-center gap-1.5">
          {onOpen && !inert ? (
            <button
              type="button"
              data-plugin-row-name=""
              aria-label={accessibleName}
              className="min-w-0 truncate rounded-sm text-left text-sm font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onOpen}
            >
              {entry.name}
            </button>
          ) : (
            <span className="min-w-0 truncate text-sm font-medium">{entry.name}</span>
          )}
          {entry.official ? (
            <BadgeCheck
              className="plugin-security-chrome size-3.5 shrink-0 text-muted-foreground"
              role="img"
              aria-label={translate(
                'auto.components.pluginCatalog.PluginListRow.official',
                'Official'
              )}
            />
          ) : null}
          {chips}
          {entry.publisher ? (
            <span className="min-w-0 shrink-[9999] truncate text-xs text-muted-foreground @max-xl/plugin-list:hidden">
              {entry.publisher}
            </span>
          ) : null}
        </div>
        <p
          data-tone={descriptionTone}
          className="mt-0.5 truncate text-xs text-muted-foreground data-[tone=destructive]:text-destructive @max-xl/plugin-list:line-clamp-2 @max-xl/plugin-list:whitespace-normal"
        >
          {description}
        </p>
      </div>
      <div className="relative z-10 flex w-33 justify-end @max-xl/plugin-list:w-auto">{status}</div>
      <div className="relative z-10 flex w-28 justify-end @max-xl/plugin-list:w-auto">{action}</div>
      <div className="relative z-10 flex justify-center">{toggle}</div>
      <div className="relative z-10 flex justify-center">{more}</div>
    </li>
  )
}
