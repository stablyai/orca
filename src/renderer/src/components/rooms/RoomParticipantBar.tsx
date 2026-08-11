import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Archive, Download, Ellipsis, Plus, Settings2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { formatTokens } from '@/components/stats/usage-formatters'
import type { RoomData } from './use-room-data'
import { RoomParticipantSessionControl } from './RoomParticipantSessionControl'
import { bindTabStripContentResizeObservers } from '../tab-bar/tab-strip-content-resize-observers'
import {
  computeTabStripScrollMetrics,
  getTabStripScrollMaskClassName,
  sameTabStripScrollMetrics,
  type TabStripScrollMetrics
} from '../tab-bar/tab-strip-scroll-metrics'

const EMPTY_OVERFLOW: TabStripScrollMetrics = {
  hasOverflow: false,
  canScrollStart: false,
  canScrollEnd: false,
  thumbSizeFraction: 1,
  thumbOffsetFraction: 0
}

export function getRoomParticipantWheelScrollLeft({
  clientWidth,
  deltaX,
  deltaY,
  scrollLeft,
  scrollWidth
}: {
  clientWidth: number
  deltaX: number
  deltaY: number
  scrollLeft: number
  scrollWidth: number
}): number | null {
  if (Math.abs(deltaY) <= Math.abs(deltaX)) {
    return null
  }
  const maxScrollLeft = Math.max(0, scrollWidth - clientWidth)
  const next = Math.min(maxScrollLeft, Math.max(0, scrollLeft + deltaY))
  return next === scrollLeft ? null : next
}

function useRoomParticipantOverflow(roomId: string | null) {
  const stripRef = useRef<HTMLDivElement>(null)
  const [metrics, setMetrics] = useState(EMPTY_OVERFLOW)
  const updateMetrics = useCallback(() => {
    const strip = stripRef.current
    if (!strip) {
      return
    }
    const next = computeTabStripScrollMetrics(strip)
    setMetrics((previous) => (sameTabStripScrollMetrics(previous, next) ? previous : next))
  }, [])

  useEffect(() => {
    const strip = stripRef.current
    if (!strip) {
      return
    }
    const onWheel = (event: WheelEvent): void => {
      const next = getRoomParticipantWheelScrollLeft({
        clientWidth: strip.clientWidth,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        scrollLeft: strip.scrollLeft,
        scrollWidth: strip.scrollWidth
      })
      if (next === null) {
        return
      }
      event.preventDefault()
      strip.scrollLeft = next
      updateMetrics()
    }
    strip.addEventListener('scroll', updateMetrics, { passive: true })
    strip.addEventListener('wheel', onWheel, { passive: false })
    const disconnectResizeObservers = bindTabStripContentResizeObservers(strip, updateMetrics)
    updateMetrics()
    return () => {
      strip.removeEventListener('scroll', updateMetrics)
      strip.removeEventListener('wheel', onWheel)
      disconnectResizeObservers()
    }
  }, [updateMetrics])

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) {
      return
    }
    strip.scrollLeft = 0
    updateMetrics()
    const frame = requestAnimationFrame(updateMetrics)
    return () => cancelAnimationFrame(frame)
  }, [roomId, updateMetrics])

  return { metrics, stripRef }
}

export function RoomParticipantBar({
  data,
  onAdd,
  onSettings,
  onExport,
  onImport,
  onArchiveToggle,
  transferring
}: {
  data: RoomData
  onAdd: () => void
  onSettings: () => void
  onExport: () => void
  onImport: () => void
  onArchiveToggle: () => void
  transferring: boolean
}): React.JSX.Element {
  const agents =
    data.snapshot?.participants.filter((participant) => participant.actorKind === 'agent') ?? []
  const archived = Boolean(data.snapshot?.room.archivedAt)
  const { metrics, stripRef } = useRoomParticipantOverflow(data.roomId)
  return (
    <header className="grid h-16 min-w-0 shrink-0 grid-cols-[minmax(0,max-content)_minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-3">
      <div className="mr-1 flex min-w-0 max-w-56 items-center gap-1">
        <div className="min-w-0 flex-1 px-2 py-1 text-left">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">
              {data.snapshot?.room.name ?? ''}
            </span>
            <span className="block truncate text-[11px] font-normal text-muted-foreground">
              {data.snapshot?.room.description ||
                translate('rooms.header.defaultTopic', 'Multi-agent room')}
            </span>
          </span>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={translate('rooms.sidebar.roomActions', 'Room actions')}
            >
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={onSettings}>
              <Settings2 /> {translate('rooms.common.settings', 'Settings')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={transferring} onSelect={onExport}>
              <Download /> {translate('rooms.archive.export', 'Export archive')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={transferring} onSelect={onImport}>
              <Upload /> {translate('rooms.archive.import', 'Import archive')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant={archived ? 'default' : 'destructive'}
              onSelect={onArchiveToggle}
            >
              <Archive />
              {archived
                ? translate('rooms.sidebar.restoreRoom', 'Restore room')
                : translate('rooms.sidebar.archiveRoom', 'Archive room')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div
        ref={stripRef}
        className={cn(
          'terminal-tab-strip flex min-w-0 flex-1 gap-2 overflow-x-auto overflow-y-hidden',
          getTabStripScrollMaskClassName(metrics)
        )}
        role="group"
        aria-label={translate('rooms.people.participants', 'Participants')}
      >
        {agents.map((participant) => (
          <RoomParticipantSessionControl
            key={participant.id}
            participant={participant}
            target={data.target}
            archived={archived}
          />
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onAdd}
        className="h-8 shrink-0"
        disabled={archived}
      >
        <Plus className="mr-1 size-3.5" />
        {translate('rooms.common.agent', 'Agent')}
      </Button>
    </header>
  )
}

export function contextLabel(
  participant: NonNullable<RoomData['snapshot']>['participants'][number]
): string {
  const context = participant.context
  if (context.usedTokens === null) {
    return translate('rooms.context.unavailable', '{{agent}} · context unavailable', {
      agent: participant.agent
    })
  }
  const used = `${context.estimated ? '~' : ''}${formatTokens(context.usedTokens)}`
  if (context.maxTokens === null) {
    return translate('rooms.context.limitUnavailable', '{{used}} used · limit unavailable', {
      used
    })
  }
  const remaining = context.remainingTokens ?? Math.max(0, context.maxTokens - context.usedTokens)
  return translate('rooms.context.usage', '{{used}} / {{max}} · {{remaining}} free', {
    used,
    max: formatTokens(context.maxTokens),
    remaining: formatTokens(remaining)
  })
}
