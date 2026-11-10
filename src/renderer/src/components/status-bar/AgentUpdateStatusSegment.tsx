import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, ArrowUpCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { AgentUpdatesState } from '../../../../shared/agent-updates/agent-update-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import { AgentUpdateRow } from './AgentUpdateRow'
import {
  refreshAgentUpdates,
  requestAgentUpdates,
  startAgentUpdatesSync,
  useAgentUpdates,
  useRemoteAgentUpdatesPolling
} from './agent-update-store'
import { useAgentUpdatesOwner } from './agent-update-owner'

type SegmentTone = 'running' | 'failed' | 'available' | 'done'

function segmentTone(rows: AgentUpdatesState['rows']): SegmentTone {
  if (rows.some((row) => row.run?.state === 'running')) {
    return 'running'
  }
  if (rows.some((row) => row.run?.state === 'failed')) {
    return 'failed'
  }
  return rows.some((row) => row.updateAvailable) ? 'available' : 'done'
}

const TONE_ICONS: Record<SegmentTone, React.JSX.Element> = {
  running: <Loader2 className="size-3 animate-spin text-muted-foreground" />,
  failed: <AlertCircle className="size-3 text-status-warning" />,
  available: <ArrowUpCircle className="size-3 text-muted-foreground" />,
  done: <CheckCircle2 className="size-3 text-status-success" />
}

export function AgentUpdateStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  // Why: agents belong to the focused workspace's machine, which may be a server.
  const owner = useAgentUpdatesOwner()
  const { rows } = useAgentUpdates(owner)
  // Why per owner: focusing another machine's workspace closes the list instead of reopening it there.
  const [openFor, setOpenFor] = useState<RuntimeClientTarget | null>(null)
  const open = owner !== null && openFor === owner

  useEffect(() => (owner ? startAgentUpdatesSync(owner) : undefined), [owner])
  useRemoteAgentUpdatesPolling(owner, open)

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpenFor(nextOpen ? owner : null)
      if (nextOpen && owner) {
        refreshAgentUpdates(owner)
      }
    },
    [owner]
  )

  if (!owner || rows.length === 0) {
    return null
  }
  const update = (agents: TuiAgent[]): void => requestAgentUpdates(owner, agents)

  const count = rows.filter((row) => row.updateAvailable || row.run?.state === 'failed').length
  const runnable = rows.filter((row) => row.action.kind === 'run' && row.updateAvailable)
  const anyRunning = rows.some((row) => row.run?.state === 'running')
  const anyDone = rows.some((row) => row.run?.state === 'done')
  const tone = segmentTone(rows)
  const tooltip = {
    running: t(
      'auto.components.status.bar.AgentUpdateStatusSegment.runningTooltip',
      'Updating agents…'
    ),
    failed: t(
      'auto.components.status.bar.AgentUpdateStatusSegment.failedTooltip',
      'Some agent updates failed'
    ),
    available: t(
      'auto.components.status.bar.AgentUpdateStatusSegment.availableTooltip',
      '{{count}} agent updates available',
      { count, defaultValue_one: '{{count}} agent update available' }
    ),
    done: t('auto.components.status.bar.AgentUpdateStatusSegment.doneTooltip', 'Agents updated')
  }[tone]

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
              aria-label={t(
                'auto.components.status.bar.AgentUpdateStatusSegment.triggerAria',
                '{{status}}. Click to open agent updates.',
                { status: tooltip }
              )}
            >
              {TONE_ICONS[tone]}
              {!iconOnly && count > 0 && (
                <span className="text-2xs font-medium tabular-nums text-muted-foreground">
                  {count}
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {tooltip}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        className="w-96 max-w-[calc(100vw-2rem)]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <span className="truncate text-2xs font-medium text-foreground">
            {t(
              'auto.components.status.bar.AgentUpdateStatusSegment.title',
              'Agent updates · {{count}}',
              { count }
            )}
          </span>
          <Button
            variant="outline"
            size="xs"
            disabled={anyRunning || runnable.length === 0}
            onClick={() => update(runnable.map((row) => row.agent))}
          >
            {t('auto.components.status.bar.AgentUpdateStatusSegment.updateAll', 'Update all')}
          </Button>
        </div>
        <ul className="max-h-[28rem] overflow-y-auto scrollbar-sleek py-1">
          {rows.map((row) => (
            <AgentUpdateRow
              key={row.agent}
              row={row}
              updatesLocked={anyRunning}
              onUpdate={() => update([row.agent])}
            />
          ))}
        </ul>
        {anyDone && (
          <p className="border-t border-border px-3 py-1.5 text-2xs text-muted-foreground">
            {t(
              'auto.components.status.bar.AgentUpdateStatusSegment.restartHint',
              'Restart running sessions to use the new version'
            )}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
