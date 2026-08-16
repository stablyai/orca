import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Plug, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  scanWorkspacePortsForTarget,
  workspacePortScanKeyForTarget
} from '@/lib/workspace-port-actions'
import {
  getExternalWorkspacePorts,
  getWorkspacePortGroups,
  sortWorkspacePortGroupsByMetric,
  sortWorkspacePortsByMetric
} from '@/lib/workspace-port-groups'
import type { ProcessMetricSortOption } from '@/lib/sort-by-process-metric'
import { SelectedTextCopyMenu } from '@/components/SelectedTextCopyMenu'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import { PortRow, WorkspaceGroupRows } from './ports-status-popover-rows'
import { ProcessMetricSortHeader } from './process-resource-metric-columns'
import { LIVE_POPOVER_POLL_MS } from '@/lib/live-popover-poll-interval'
import {
  EXTERNAL_PORTS_HISTORY_KEY,
  readWorkspacePortMemoryHistory,
  recordWorkspacePortMemorySamples
} from '@/lib/workspace-port-group-memory-history'
import { Sparkline } from './process-metric-sparkline'
import { translate } from '@/i18n/i18n'

type PortsStatusSegmentProps = {
  compact?: boolean
  iconOnly: boolean
}

export function PortsStatusSegment({ iconOnly }: PortsStatusSegmentProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const scan = useAppStore((s) => s.workspacePortScan?.result ?? null)
  const refreshing = useAppStore((s) => s.workspacePortScanRefreshing)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const setWorkspacePortScan = useAppStore((s) => s.setWorkspacePortScan)
  const setWorkspacePortScanForKey = useAppStore((s) => s.setWorkspacePortScanForKey)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [open, setOpen] = useState(false)
  const [externalOpen, setExternalOpen] = useState(false)
  const [sortOption, setSortOption] = useState<ProcessMetricSortOption>('memory')
  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const scanKey = workspacePortScanKeyForTarget(runtimeTarget)

  const workspaceGroups = useMemo(() => getWorkspacePortGroups(scan), [scan])
  const externalPorts = useMemo(() => getExternalWorkspacePorts(scan), [scan])
  // Why: sort reorders within each project's ports and across projects, but
  // never flattens the workspace/external boundary or the per-project grouping.
  const sortedWorkspaceGroups = useMemo(
    () => sortWorkspacePortGroupsByMetric(workspaceGroups, sortOption),
    [workspaceGroups, sortOption]
  )
  const sortedExternalPorts = useMemo(
    () => sortWorkspacePortsByMetric(externalPorts, sortOption),
    [externalPorts, sortOption]
  )
  const workspacePortCount = workspaceGroups.reduce((count, group) => count + group.ports.length, 0)
  const totalCount = workspacePortCount + externalPorts.length

  // Why: mirrors the Resource Manager's history ring — only sample while the
  // popover is open, so the trend reflects time actually spent watching it.
  useEffect(() => {
    if (!open) {
      return
    }
    recordWorkspacePortMemorySamples(workspaceGroups, externalPorts)
  }, [open, workspaceGroups, externalPorts])

  // Why: the shared 30s background scan (WorkspacePortScanner) stays quiet so
  // it doesn't spawn lsof/ps for every window all the time; this popover polls
  // faster on its own, matching the Resource Manager's open-only cadence.
  const refreshScan = useCallback(() => {
    void scanWorkspacePortsForTarget(runtimeTarget)
      .then((result) => {
        setWorkspacePortScanForKey(scanKey, result)
        setWorkspacePortScan({ key: scanKey, result })
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        setWorkspacePortScan({
          key: scanKey,
          result: {
            platform: 'unknown',
            scannedAt: Date.now(),
            ports: [],
            unavailableReason: message || 'Workspace port scan failed.'
          }
        })
      })
  }, [runtimeTarget, scanKey, setWorkspacePortScan, setWorkspacePortScanForKey])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (!nextOpen) {
        return
      }
      recordFeatureInteraction('ports')
      refreshScan()
    },
    [recordFeatureInteraction, refreshScan]
  )

  // Poll ports only while the popover is open, same cadence as the Resource
  // Manager's memory poll — the closed badge stays on the shared 30s scan.
  useEffect(() => {
    if (!open) {
      return
    }
    const timer = window.setInterval(refreshScan, LIVE_POPOVER_POLL_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [open, refreshScan])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-accent/70"
              aria-label={translate(
                'auto.components.status.bar.PortsStatusSegment.b8bc3e420a',
                'Ports, {{value0}} workspace {{value1}}',
                { value0: workspacePortCount, value1: workspacePortCount === 1 ? 'port' : 'ports' }
              )}
            >
              {refreshing ? (
                <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
              ) : (
                <Plug className="size-3 text-muted-foreground" />
              )}
              {!iconOnly && (
                <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
                  {workspacePortCount}
                </span>
              )}
              {iconOnly && totalCount > 0 && (
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {workspacePortCount}
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {translate(
            'auto.components.status.bar.PortsStatusSegment.ca41be2802',
            'Ports — {{value0}} workspace {{value1}}{{value2}}',
            {
              value0: workspacePortCount,
              value1:
                workspacePortCount === 1
                  ? translate('auto.components.status.bar.PortsStatusSegment.45834a9ace', 'port')
                  : translate('auto.components.status.bar.PortsStatusSegment.8caaa86e9a', 'ports'),
              value2:
                externalPorts.length > 0
                  ? translate(
                      'auto.components.status.bar.PortsStatusSegment.a8e4bdb412',
                      ' · {{value0}} external',
                      { value0: externalPorts.length }
                    )
                  : ''
            }
          )}
        </TooltipContent>
      </Tooltip>

      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
        className="w-[24rem] max-w-[calc(100vw-2rem)] p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <SelectedTextCopyMenu>
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
            <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-foreground">
              <Plug className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {translate('auto.components.status.bar.PortsStatusSegment.c22ea609fd', 'Ports')}
              </span>
            </div>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {translate(
                'auto.components.status.bar.PortsStatusSegment.2b84c4d11f',
                '{{value0}} workspace · {{value1}} external',
                { value0: workspacePortCount, value1: externalPorts.length }
              )}
            </span>
          </div>

          {scan?.unavailableReason ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              {translate(
                'auto.components.status.bar.PortsStatusSegment.95495019ed',
                'Port scan unavailable on {{value0}}: {{value1}}',
                { value0: scan.platform, value1: scan.unavailableReason }
              )}
            </div>
          ) : (
            <>
              {(workspaceGroups.length > 0 || externalPorts.length > 0) && (
                <ProcessMetricSortHeader
                  sortOption={sortOption}
                  onSortOptionChange={setSortOption}
                  memoryLabel={translate(
                    'auto.components.status.bar.PortsStatusSegment.rss',
                    'RSS'
                  )}
                  showUptimeColumn
                  uptimeLabel={translate(
                    'auto.components.status.bar.PortsStatusSegment.uptime',
                    'Uptime'
                  )}
                />
              )}
              <div className="max-h-[28rem] overflow-y-auto scrollbar-sleek">
                {sortedWorkspaceGroups.length > 0 ? (
                  sortedWorkspaceGroups.map((group) => (
                    <WorkspaceGroupRows
                      key={group.worktreeId}
                      group={group}
                      activeWorktreeId={activeWorktreeId}
                      history={readWorkspacePortMemoryHistory(group.worktreeId)}
                    />
                  ))
                ) : (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    {refreshing
                      ? translate(
                          'auto.components.status.bar.PortsStatusSegment.c174bbbfed',
                          'Scanning for workspace ports...'
                        )
                      : translate(
                          'auto.components.status.bar.PortsStatusSegment.3a87d54dfb',
                          'No workspace ports detected'
                        )}
                  </div>
                )}

                <section className="border-t border-border/60">
                  <button
                    type="button"
                    className="sticky top-0 z-10 flex w-full items-center gap-1.5 border-b border-border/40 bg-popover px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    aria-expanded={externalOpen}
                    onClick={() => {
                      recordFeatureInteraction('ports')
                      setExternalOpen((value) => !value)
                    }}
                  >
                    {externalOpen ? (
                      <ChevronDown className="size-3" />
                    ) : (
                      <ChevronRight className="size-3" />
                    )}
                    <span>
                      {translate(
                        'auto.components.status.bar.PortsStatusSegment.7dac3ecc9d',
                        'External Ports'
                      )}
                    </span>
                    <span className="ml-auto flex items-center gap-1.5">
                      <Sparkline
                        samples={readWorkspacePortMemoryHistory(EXTERNAL_PORTS_HISTORY_KEY)}
                      />
                      <span className="font-mono text-[10px]">{externalPorts.length}</span>
                    </span>
                  </button>
                  {externalOpen && (
                    <div className="px-1 pb-1">
                      {sortedExternalPorts.length > 0 ? (
                        sortedExternalPorts.map((port) => (
                          <PortRow
                            key={port.id}
                            port={port}
                            activeWorktreeId={activeWorktreeId}
                            external
                          />
                        ))
                      ) : (
                        <div className="px-2 py-2 text-xs text-muted-foreground">
                          {translate(
                            'auto.components.status.bar.PortsStatusSegment.4ebf90c12e',
                            'No external ports detected'
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </SelectedTextCopyMenu>
      </PopoverContent>
    </Popover>
  )
}
