import React, { useCallback, useMemo, useState } from 'react'
import { Plug, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  scanWorkspacePortsForTarget,
  workspacePortRuntimeTargetKey
} from '@/lib/workspace-port-actions'
import { getExternalWorkspacePorts, getWorkspacePortGroups } from '@/lib/workspace-port-groups'
import { SelectedTextCopyMenu } from '@/components/SelectedTextCopyMenu'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import { PortRow, WorkspaceGroupRows } from './ports-status-popover-rows'

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
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [open, setOpen] = useState(false)
  const [externalOpen, setExternalOpen] = useState(false)
  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const scanKey = `${workspacePortRuntimeTargetKey(runtimeTarget)}:all`

  const workspaceGroups = useMemo(() => getWorkspacePortGroups(scan), [scan])
  const externalPorts = useMemo(() => getExternalWorkspacePorts(scan), [scan])
  const workspacePortCount = workspaceGroups.reduce((count, group) => count + group.ports.length, 0)
  const totalCount = workspacePortCount + externalPorts.length
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (!nextOpen) {
        return
      }
      recordFeatureInteraction('ports')
      // Why: the 30s background poll is intentionally quiet; opening the
      // popover should still collapse that stale window without flashing icons.
      void scanWorkspacePortsForTarget(runtimeTarget)
        .then((result) => {
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
    },
    [recordFeatureInteraction, runtimeTarget, scanKey, setWorkspacePortScan]
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
              aria-label={`Ports, ${workspacePortCount} workspace ${workspacePortCount === 1 ? 'port' : 'ports'}`}
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
          Ports — {workspacePortCount} workspace
          {workspacePortCount === 1 ? ' port' : ' ports'}
          {externalPorts.length > 0 ? ` · ${externalPorts.length} external` : ''}
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
              <span className="truncate">Ports</span>
            </div>
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {workspacePortCount} workspace · {externalPorts.length} external
            </span>
          </div>

          {scan?.unavailableReason ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              Port scan unavailable on {scan.platform}: {scan.unavailableReason}
            </div>
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
                  {refreshing ? 'Scanning for workspace ports...' : 'No workspace ports detected'}
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
                  <span>External Ports</span>
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
                        No external ports detected
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
