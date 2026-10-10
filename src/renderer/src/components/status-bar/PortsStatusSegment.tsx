import React, { useCallback, useMemo, useState } from 'react'
import { Plug, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import {
  publishWorkspacePortScanForHost,
  scanWorkspacePortsForTarget,
  workspacePortScanKeyForTarget
} from '@/lib/workspace-port-actions'
import { useWorktreeRuntimeTarget } from '@/runtime/use-worktree-runtime-target'
import {
  getUnavailableWorkspacePortHosts,
  type WorkspacePortHostRef
} from '@/lib/workspace-port-host-availability'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import { getExternalWorkspacePorts, getWorkspacePortGroups } from '@/lib/workspace-port-groups'
import { SelectedTextCopyMenu } from '@/components/SelectedTextCopyMenu'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import { PortRow, WorkspaceGroupRows } from './ports-status-popover-rows'
import { translate } from '@/i18n/i18n'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

type PortsStatusSegmentProps = {
  compact?: boolean
  iconOnly: boolean
}

/** Status-bar plug icon with the workspace port count and a per-host ports popover. */
export function PortsStatusSegment({ iconOnly }: PortsStatusSegmentProps): React.JSX.Element {
  const scan = useAppStore((s) => s.workspacePortScan?.result ?? null)
  const refreshing = useAppStore((s) => s.workspacePortScanRefreshing)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const replaceWorkspacePortScans = useAppStore((s) => s.replaceWorkspacePortScans)
  const scansByKey = useAppStore((s) => s.workspacePortScansByKey)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [open, setOpen] = useState(false)
  const [externalOpen, setExternalOpen] = useState(false)
  const runtimeTarget = useWorktreeRuntimeTarget(activeWorktreeId)
  const scanKey = runtimeTarget ? workspacePortScanKeyForTarget(runtimeTarget) : null

  const workspaceGroups = useMemo(() => getWorkspacePortGroups(scan), [scan])
  const externalPorts = useMemo(() => getExternalWorkspacePorts(scan), [scan])
  const unavailableHosts = useMemo(() => getUnavailableWorkspacePortHosts(scansByKey), [scansByKey])
  const hostLabel = useCallback(
    (host: WorkspacePortHostRef, hostScanKey: string, platform: NodeJS.Platform | null) => {
      if (host.kind === 'local') {
        // Why: a paired web client's own userAgent is not the Orca host's
        // platform, so name the machine the scan actually ran on.
        return getLocalExecutionHostLabel(platform)
      }
      if (host.kind === 'unknown') {
        return hostScanKey
      }
      return (
        runtimeEnvironments.find((environment) => environment.id === host.environmentId)?.name ??
        host.environmentId
      )
    },
    [runtimeEnvironments]
  )
  const workspacePortCount = workspaceGroups.reduce((count, group) => count + group.ports.length, 0)
  const totalCount = workspacePortCount + externalPorts.length
  const unavailableNotices = useMemo<PortScanUnavailableNotice[]>(() => {
    if (unavailableHosts.length > 0) {
      return unavailableHosts.map((entry) => ({
        id: entry.scanKey,
        host: hostLabel(entry.host, entry.scanKey, entry.platform),
        reason: entry.reason
      }))
    }
    // Why: a projection published without per-host scans has no host to name.
    return scan?.unavailableReason
      ? [{ id: 'projection', host: scan.platform, reason: scan.unavailableReason }]
      : []
  }, [hostLabel, scan?.platform, scan?.unavailableReason, unavailableHosts])
  // Why: a failed scan keeps the host's last-good ports, and those ports are
  // counted in the badge and header — replacing the list with the notice would
  // leave the popover claiming N ports over an empty body. Only take over the
  // body when there is genuinely nothing left to list.
  const noticeReplacesList = Boolean(scan?.unavailableReason) && totalCount === 0
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (!nextOpen) {
        return
      }
      recordFeatureInteraction('ports')
      if (!runtimeTarget || !scanKey) {
        return
      }
      // Why: the 30s background poll is intentionally quiet; opening the
      // popover should still collapse that stale window without flashing icons.
      const publish = (result: WorkspacePortScanResult): void => {
        publishWorkspacePortScanForHost({
          scanKey,
          scan: result,
          replaceWorkspacePortScans,
          getWorkspacePortScansByKey: () => useAppStore.getState().workspacePortScansByKey
        })
      }
      void scanWorkspacePortsForTarget(runtimeTarget)
        .then(publish)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          // Why: one dropped scan must not clear the host's last-good ports the
          // way the background poll's debounce does not; the failure is still
          // recorded so the host is named by the unavailable notice below.
          const previous = useAppStore.getState().workspacePortScansByKey[scanKey]
          publish({
            platform: previous?.platform ?? 'unknown',
            scannedAt: Date.now(),
            ports: previous?.ports ?? [],
            unavailableReason: message || 'Workspace port scan failed.'
          })
        })
    },
    [recordFeatureInteraction, runtimeTarget, scanKey, replaceWorkspacePortScans]
  )

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

          {unavailableNotices.length > 0 && !noticeReplacesList && (
            <PortScanUnavailableNotices
              notices={unavailableNotices}
              className="border-b border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground"
            />
          )}

          {noticeReplacesList ? (
            <PortScanUnavailableNotices
              notices={unavailableNotices}
              className="px-3 py-3 text-xs text-muted-foreground"
            />
          ) : (
            <div className="max-h-[28rem] overflow-y-auto scrollbar-sleek">
              {workspaceGroups.length > 0 ? (
                workspaceGroups.map((group) => (
                  <WorkspaceGroupRows
                    key={group.worktreeId}
                    group={group}
                    activeWorktreeId={activeWorktreeId}
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
                  <span className="ml-auto font-mono text-[10px]">{externalPorts.length}</span>
                </button>
                {externalOpen && (
                  <div className="px-1 pb-1">
                    {externalPorts.length > 0 ? (
                      externalPorts.map((port) => (
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
          )}
        </SelectedTextCopyMenu>
      </PopoverContent>
    </Popover>
  )
}

type PortScanUnavailableNotice = { id: string; host: string; reason: string }

function PortScanUnavailableNotices({
  notices,
  className
}: {
  notices: PortScanUnavailableNotice[]
  className: string
}): React.JSX.Element {
  return (
    <div className={className}>
      {notices.map((notice) => (
        <div key={notice.id} className="truncate">
          {translate(
            'auto.components.status.bar.PortsStatusSegment.95495019ed',
            'Port scan unavailable on {{value0}}: {{value1}}',
            { value0: notice.host, value1: notice.reason }
          )}
        </div>
      ))}
    </div>
  )
}
