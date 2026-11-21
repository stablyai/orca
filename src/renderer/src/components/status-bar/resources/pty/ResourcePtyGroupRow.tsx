import { memo } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ResourcePtyGroup, ResourcePtyRow } from './resource-pty-view-model'
import { ResourcePtyProcessIcon } from './ResourcePtyProcessIcon'

const STRIP_LIMIT = 6

function ptyHoverName(row: ResourcePtyRow): string {
  const process = row.session.foregroundProcess?.trim()
  return process ? `${row.label} · ${process}` : row.label
}

export const ResourcePtyGroupRow = memo(function ResourcePtyGroupRow({
  group,
  open,
  canEndAll,
  onToggle,
  onEndAll
}: {
  group: ResourcePtyGroup
  open: boolean
  canEndAll: boolean
  onToggle: (key: string) => void
  onEndAll: (group: ResourcePtyGroup, source: Element) => void
}) {
  const t = useTranslate()
  const name =
    group.kind === 'unbound'
      ? t('resourceManager.pty.notInTab', 'Not in a tab')
      : (group.name ?? t('resourceManager.pty.unassigned', 'Unassigned'))
  const hidden = group.rows.length - STRIP_LIMIT
  return (
    <div
      data-resource-pty-group={group.key}
      className="group/line flex h-[26px] items-center gap-1.5 pr-2 hover:bg-accent/50"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(group.key)}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-3 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
            open && 'rotate-90'
          )}
        />
        <span className="truncate">{name}</span>
        <span className="sr-only">
          {t('resourceManager.pty.count', '{{count}} PTYs', {
            count: group.rows.length,
            defaultValue_one: '{{count}} PTY'
          })}
        </span>
      </button>
      <span aria-hidden className="flex shrink-0 items-center gap-1">
        {group.rows.slice(0, STRIP_LIMIT).map((row) => (
          <Tooltip key={row.identity}>
            <TooltipTrigger asChild>
              <span className="inline-flex size-3.5 items-center justify-center">
                <ResourcePtyProcessIcon process={row.session.foregroundProcess} />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {ptyHoverName(row)}
            </TooltipContent>
          </Tooltip>
        ))}
        {hidden > 0 && (
          <span className="text-2xs text-muted-foreground tabular-nums">+{hidden}</span>
        )}
      </span>
      <Button
        variant="ghost"
        size="xs"
        disabled={!canEndAll}
        onClick={(event) => onEndAll(group, event.currentTarget)}
        aria-label={t('resourceManager.pty.endAllNamed', 'End all PTYs in {{group}}', {
          group: name
        })}
        className="hidden h-[22px] px-1.5 text-2xs hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/15 group-focus-within/line:inline-flex group-hover/line:inline-flex"
      >
        {t('resourceManager.pty.endAll', 'End all')}
      </Button>
    </div>
  )
})
