import React, { useCallback, useMemo, useState } from 'react'
import {
  Plug,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  LoaderCircle,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  addressForPort,
  canStopWorkspacePort,
  killWorkspacePortForTarget,
  openWorkspacePortInBrowser,
  scanWorkspacePortsForTarget,
  workspacePortRuntimeTargetKey
} from '@/lib/workspace-port-actions'
import {
  getExternalWorkspacePorts,
  getWorkspacePortGroups,
  type WorkspacePortGroup
} from '@/lib/workspace-port-groups'
import { SelectedTextCopyMenu } from '@/components/SelectedTextCopyMenu'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'
import type { WorkspacePort } from '../../../../shared/workspace-ports'

type PortsStatusSegmentProps = {
  compact?: boolean
  iconOnly: boolean
}

function PortAction({
  label,
  onClick,
  disabled,
  children
}: {
  label: string
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground/35"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function PortRow({
  port,
  activeWorktreeId,
  external
}: {
  port: WorkspacePort
  activeWorktreeId: string | null
  external?: boolean
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const setRemoteBrowserPageHandle = useAppStore((s) => s.setRemoteBrowserPageHandle)
  const setWorkspacePortScan = useAppStore((s) => s.setWorkspacePortScan)
  const setWorkspacePortScanRefreshing = useAppStore((s) => s.setWorkspacePortScanRefreshing)
  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const processLabel = port.processName ?? (port.pid ? `PID ${port.pid}` : 'Unknown process')
  const canOpen = port.kind === 'workspace' || Boolean(activeWorktreeId)
  const canStop = canStopWorkspacePort(port)

  const handleOpen = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      void openWorkspacePortInBrowser({
        port,
        activeWorktreeId,
        runtimeTarget,
        createBrowserTab,
        setRemoteBrowserPageHandle
      }).then((result) => {
        if (!result.ok) {
          toast.error('Failed to open browser', { description: result.reason })
        }
      })
    },
    [activeWorktreeId, createBrowserTab, port, runtimeTarget, setRemoteBrowserPageHandle]
  )

  const handleCopy = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      void window.api.ui.writeClipboardText(addressForPort(port))
      toast.success(`Copied ${port.port}`)
    },
    [port]
  )

  const handleStop = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (!canStopWorkspacePort(port)) {
        return
      }
      const run = async (): Promise<void> => {
        const result = await killWorkspacePortForTarget(runtimeTarget, {
          repoId: port.owner.repoId,
          pid: port.pid,
          port: port.port
        })
        if (!result.ok) {
          toast.error(result.reason)
          return
        }
        toast.success(`Stopped process on ${port.port}`)
        setWorkspacePortScanRefreshing(true)
        try {
          const scan = await scanWorkspacePortsForTarget(runtimeTarget)
          setWorkspacePortScan({
            key: `${workspacePortRuntimeTargetKey(runtimeTarget)}:all`,
            result: scan
          })
        } finally {
          setWorkspacePortScanRefreshing(false)
        }
      }
      void run()
    },
    [port, runtimeTarget, setWorkspacePortScan, setWorkspacePortScanRefreshing]
  )

  return (
    <div className="group/port grid min-w-0 grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50">
      <span className="select-text font-mono text-[12px] font-semibold tabular-nums text-foreground">
        {port.port}
      </span>
      <div className="min-w-0 space-y-0.5">
        <div className="relative flex h-5 min-w-0 items-center">
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <span className="block min-w-0 select-text truncate text-[11px] text-muted-foreground">
                {processLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {processLabel}
            </TooltipContent>
          </Tooltip>
          <div className="absolute inset-y-0 right-0 flex items-center gap-0.5 rounded-md border border-border/40 bg-popover/95 px-0.5 opacity-0 shadow-xs transition-opacity group-hover/port:opacity-100 group-focus-within/port:opacity-100">
            <PortAction label="Open in Orca Browser" onClick={handleOpen} disabled={!canOpen}>
              <ExternalLink className="size-3" />
            </PortAction>
            <PortAction label={`Copy ${addressForPort(port)}`} onClick={handleCopy}>
              <Copy className="size-3" />
            </PortAction>
            <PortAction label="Stop Process" disabled={!canStop} onClick={handleStop}>
              <Trash2 className="size-3" />
            </PortAction>
          </div>
        </div>
        <div className="select-text truncate text-[10px] text-muted-foreground/70">
          {external ? port.kind : addressForPort(port)}
        </div>
      </div>
    </div>
  )
}

function WorkspaceGroupRows({
  group,
  activeWorktreeId
}: {
  group: WorkspacePortGroup
  activeWorktreeId: string | null
}): React.JSX.Element {
  return (
    <section className="border-t border-border/40 first:border-t-0">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
          {group.displayName}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
          {group.ports.length}
        </span>
      </div>
      <div className="px-1 pb-1">
        {group.ports.map((port) => (
          <PortRow key={port.id} port={port} activeWorktreeId={activeWorktreeId} />
        ))}
      </div>
    </section>
  )
}

export function PortsStatusSegment({ iconOnly }: PortsStatusSegmentProps): React.JSX.Element {
  const scan = useAppStore((s) => s.workspacePortScan?.result ?? null)
  const refreshing = useAppStore((s) => s.workspacePortScanRefreshing)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const [open, setOpen] = useState(false)
  const [externalOpen, setExternalOpen] = useState(false)

  const workspaceGroups = useMemo(() => getWorkspacePortGroups(scan), [scan])
  const externalPorts = useMemo(() => getExternalWorkspacePorts(scan), [scan])
  const workspacePortCount = workspaceGroups.reduce((count, group) => count + group.ports.length, 0)
  const totalCount = workspacePortCount + externalPorts.length

  return (
    <Popover open={open} onOpenChange={setOpen}>
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
                  className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.05em] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  aria-expanded={externalOpen}
                  onClick={() => setExternalOpen((value) => !value)}
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
