import { memo } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { ResourcePtyGroup } from './resource-pty-view-model'
import {
  useResourcePtyGroupCanEnd,
  type useResourcePtyEndableGroups
} from './use-resource-pty-endable-groups'

export const ResourcePtyGroupRow = memo(function ResourcePtyGroupRow({
  group,
  open,
  allowEndAll,
  endableGroups,
  checking,
  onToggle,
  onEndAll
}: {
  group: ResourcePtyGroup
  open: boolean
  allowEndAll: boolean
  endableGroups: ReturnType<typeof useResourcePtyEndableGroups>
  checking: boolean
  onToggle: (key: string) => void
  onEndAll: (group: ResourcePtyGroup, source: Element) => void
}) {
  const t = useTranslate()
  const canEndAll = useResourcePtyGroupCanEnd(endableGroups, group.key)
  const name =
    group.kind === 'unbound'
      ? t('resourceManager.pty.notInTab', 'Not in a tab')
      : (group.name ?? t('resourceManager.pty.unassigned', 'Unassigned'))
  return (
    <div
      data-resource-pty-group={group.key}
      className="group/line flex h-[26px] items-center gap-1.5 pr-2 hover:bg-accent/50"
    >
      <button
        type="button"
        title={name}
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
      {checking && (
        <span role="status" className="text-2xs text-muted-foreground">
          {t('resourceManager.pty.checkingProcesses', 'Checking processes…')}
        </span>
      )}
      <Button
        variant="ghost-destructive"
        size="xs-compact"
        disabled={!allowEndAll || !canEndAll}
        hidden={checking}
        onClick={(event) => onEndAll(group, event.currentTarget)}
        aria-label={t('resourceManager.pty.endAllNamed', 'End all PTYs in {{group}}', {
          group: name
        })}
        className={cn(
          'hidden',
          !checking && 'group-has-[:focus-visible]/line:inline-flex group-hover/line:inline-flex'
        )}
      >
        {t('resourceManager.pty.endAll', 'End all')}
      </Button>
    </div>
  )
})
