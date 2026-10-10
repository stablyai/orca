import React from 'react'
import { AlertTriangle, ChevronDown, Loader2, Server, ServerOff } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { HostHeaderRow } from '../../host-section-rows'
import { HostSectionHeaderMenu } from '../../HostSectionHeaderMenu'

function formatSectionActivityLabel(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? '' : 's'}`
}

function SectionMetricsBadge({ count }: { count: number }): React.JSX.Element {
  const totalLabel = formatSectionActivityLabel(count, 'workspace')

  return (
    <span
      className="inline-flex h-4 shrink-0 overflow-hidden rounded-full border border-worktree-sidebar-border bg-worktree-sidebar-accent text-[9px] font-medium leading-none text-muted-foreground/90"
      aria-label={totalLabel}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-full min-w-4 items-center justify-center px-1.5">
            {count}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {totalLabel}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}

function HostHeaderHealthIcon({
  health
}: {
  health: HostHeaderRow['health']
}): React.JSX.Element | null {
  // Why: only surface states needing attention; healthy is the silent default.
  if (health === 'connecting') {
    return <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
  }
  if (health === 'blocked' || health === 'error') {
    return <AlertTriangle className="size-3 shrink-0 text-destructive" />
  }
  return null
}

function getHostHeaderDetail(row: HostHeaderRow): { text: string; isWarning: boolean } | null {
  // Why: a blocked compatibility verdict earns a compact warning so the host stands out.
  if (row.health === 'blocked') {
    return {
      text: translate('auto.components.sidebar.WorktreeList.7a8b9c0d1e', 'Update required'),
      isWarning: true
    }
  }
  // Why: auth-failed needs a worded status; the health icon alone doesn't tell the user to re-auth.
  if (row.connectionStatus === 'auth-failed') {
    return {
      text: translate(
        'auto.components.sidebar.WorktreeList.hostAuthNeeded',
        'Authentication needed'
      ),
      isWarning: true
    }
  }
  if (row.health === 'disconnected') {
    return {
      text: translate('auto.components.sidebar.WorktreeList.hostDisconnected', 'Disconnected'),
      isWarning: false
    }
  }
  // Why: show the transport detail only for remote hosts; it's noise under the local label.
  if (row.kind !== 'local') {
    return { text: row.detail, isWarning: false }
  }
  return null
}

export function HostSectionHeader({
  row,
  onToggle,
  onDragPointerDown,
  dragging
}: {
  row: HostHeaderRow
  onToggle: () => void
  onDragPointerDown?: (event: React.PointerEvent<HTMLElement>) => void
  dragging?: boolean
}): React.JSX.Element {
  const isBlocked = row.health === 'blocked'
  const isDisconnected = row.health === 'disconnected'
  const detail = getHostHeaderDetail(row)
  return (
    <div className="px-2 pt-1">
      {/* Why: outlined card + server glyph marks hosts as machines, not mere groups. */}
      <div
        role="button"
        tabIndex={0}
        data-host-header-drag-id={row.hostId}
        aria-expanded={!row.collapsed}
        className={cn(
          'group/host-header flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border px-2 text-left transition-all',
          onDragPointerDown && 'cursor-grab active:cursor-grabbing',
          isBlocked
            ? 'border-destructive/40 bg-destructive/10'
            : isDisconnected
              ? 'border-worktree-sidebar-border/70 bg-worktree-sidebar-accent/35 text-muted-foreground'
              : 'border-worktree-sidebar-border bg-worktree-sidebar-accent/70',
          dragging && 'pointer-events-none opacity-0'
        )}
        onPointerDown={onDragPointerDown}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        {isDisconnected ? (
          <ServerOff className="size-3.5 shrink-0 text-muted-foreground/80" />
        ) : (
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <HostHeaderHealthIcon health={row.health} />
        {/* Why: badge hugs the label (like repo headers) instead of floating by the hover controls. */}
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span
            className={cn(
              'min-w-0 truncate text-[12px] font-semibold leading-none',
              isDisconnected ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {row.label}
          </span>
          {detail ? (
            <span
              className={cn(
                'shrink-0 truncate text-[10px] leading-none',
                detail.isWarning ? 'text-destructive' : 'text-muted-foreground/70'
              )}
            >
              {detail.text}
            </span>
          ) : null}
          <SectionMetricsBadge count={row.count} />
        </div>
        <div className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/60 can-hover:opacity-0 transition-opacity group-hover/host-header:opacity-100">
          <ChevronDown
            className={cn('size-3.5 transition-transform', row.collapsed && '-rotate-90')}
          />
        </div>
        <span data-host-header-action="">
          <HostSectionHeaderMenu row={row} />
        </span>
      </div>
    </div>
  )
}
