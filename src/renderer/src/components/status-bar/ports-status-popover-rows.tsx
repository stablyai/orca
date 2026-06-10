import React, { useCallback, useMemo } from 'react'
import { Copy, ExternalLink, FolderOpen, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  addressForPort,
  canStopWorkspacePort,
  goToWorkspacePortOwner,
  killWorkspacePortForTarget,
  openWorkspacePortInBrowser,
  refreshWorkspacePortScanAfterStop,
  shouldOpenWorkspacePortInOrcaBrowser
} from '@/lib/workspace-port-actions'
import type { WorkspacePortGroup } from '@/lib/workspace-port-groups'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import { translate } from '@/i18n/i18n'

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
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    onClick(event)
    if (event.detail > 0) {
      event.currentTarget.blur()
    }
  }

  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="size-5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground/35"
      aria-label={label}
      onClick={handleClick}
      disabled={disabled}
    >
      {children}
    </Button>
  )

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        {disabled ? <span className="inline-flex">{button}</span> : button}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="z-[70]">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function PortRow({
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
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const processLabel = port.processName ?? (port.pid ? `PID ${port.pid}` : 'Unknown process')
  const openInOrcaBrowser = shouldOpenWorkspacePortInOrcaBrowser(settings)
  const canOpen = !openInOrcaBrowser || port.kind === 'workspace' || Boolean(activeWorktreeId)
  const canStop = canStopWorkspacePort(port)

  const handleOpen = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      recordFeatureInteraction('ports')
      void openWorkspacePortInBrowser({
        port,
        activeWorktreeId,
        runtimeTarget,
        createBrowserTab,
        setRemoteBrowserPageHandle,
        openInOrcaBrowser
      }).then((result) => {
        if (!result.ok) {
          toast.error(
            translate(
              'auto.components.status.bar.ports.status.popover.rows.b854ec9ff5',
              'Failed to open browser'
            ),
            { description: result.reason }
          )
        }
      })
    },
    [
      activeWorktreeId,
      createBrowserTab,
      openInOrcaBrowser,
      port,
      recordFeatureInteraction,
      runtimeTarget,
      setRemoteBrowserPageHandle
    ]
  )

  const handleCopy = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      recordFeatureInteraction('ports')
      const address = addressForPort(port)
      void window.api.ui.writeClipboardText(address)
      toast.success(
        translate(
          'auto.components.status.bar.ports.status.popover.rows.480d8f2347',
          'Copied {{value0}}',
          { value0: address }
        )
      )
    },
    [port, recordFeatureInteraction]
  )

  const handleStop = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (!canStopWorkspacePort(port)) {
        return
      }
      recordFeatureInteraction('ports')
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
        toast.success(
          translate(
            'auto.components.status.bar.ports.status.popover.rows.acdb6df590',
            'Stopped process on {{value0}}',
            { value0: port.port }
          )
        )
        const refreshResult = await refreshWorkspacePortScanAfterStop({
          runtimeTarget,
          setWorkspacePortScan,
          setWorkspacePortScanRefreshing
        })
        if (!refreshResult.ok) {
          toast.error(
            translate(
              'auto.components.status.bar.ports.status.popover.rows.e4a709548c',
              'Failed to refresh ports'
            ),
            {
              description: refreshResult.reason
            }
          )
        }
      }
      void run()
    },
    [
      port,
      recordFeatureInteraction,
      runtimeTarget,
      setWorkspacePortScan,
      setWorkspacePortScanRefreshing
    ]
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
            <PortAction
              label={translate(
                'auto.components.status.bar.ports.status.popover.rows.085f4f0334',
                'Open in Browser'
              )}
              onClick={handleOpen}
              disabled={!canOpen}
            >
              <ExternalLink className="size-3" />
            </PortAction>
            <PortAction
              label={translate(
                'auto.components.status.bar.ports.status.popover.rows.536d48a5dc',
                'Copy {{value0}}',
                { value0: addressForPort(port) }
              )}
              onClick={handleCopy}
            >
              <Copy className="size-3" />
            </PortAction>
            <PortAction
              label={translate(
                'auto.components.status.bar.ports.status.popover.rows.0e72c8d9fb',
                'Stop Process'
              )}
              disabled={!canStop}
              onClick={handleStop}
            >
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

export function WorkspaceGroupRows({
  group,
  activeWorktreeId
}: {
  group: WorkspacePortGroup
  activeWorktreeId: string | null
}): React.JSX.Element {
  const handleGoToWorkspace = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      const ownerPort = group.ports[0]
      if (!ownerPort || !goToWorkspacePortOwner(ownerPort)) {
        toast.error(
          translate(
            'auto.components.status.bar.ports.status.popover.rows.f2b813345f',
            'Workspace unavailable'
          )
        )
      }
    },
    [group.ports]
  )

  return (
    <section className="border-t border-border/40 first:border-t-0">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border/40 bg-popover px-3 py-2">
        <span className="min-w-0 truncate text-[12px] font-medium text-foreground">
          {group.displayName}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <PortAction
            label={translate(
              'auto.components.status.bar.ports.status.popover.rows.a49ea79246',
              'Go to Worktree'
            )}
            onClick={handleGoToWorkspace}
            disabled={group.ports.length === 0}
          >
            <FolderOpen className="size-3" />
          </PortAction>
          <span className="font-mono text-[10px] text-muted-foreground/70">
            {group.ports.length}
          </span>
        </div>
      </div>
      <div className="px-1 pb-1">
        {group.ports.map((port) => (
          <PortRow key={port.id} port={port} activeWorktreeId={activeWorktreeId} />
        ))}
      </div>
    </section>
  )
}
