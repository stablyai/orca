import React, { useCallback, useMemo } from 'react'
import { Cable, Copy, ExternalLink, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  addressForPort,
  canStopWorkspacePort,
  killWorkspacePortForTarget,
  openWorkspacePortInBrowser,
  scanWorkspacePortsForTarget,
  workspacePortRuntimeTargetKey
} from '@/lib/workspace-port-actions'
import type { WorkspacePort } from '../../../../shared/workspace-ports'

type WorktreeCardPortsProps = {
  ports: WorkspacePort[]
}

function PortAction({
  label,
  onClick,
  children
}: {
  label: string
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-6 text-muted-foreground hover:text-foreground"
          aria-label={label}
          onClick={onClick}
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

function WorktreePortRow({ port }: { port: WorkspacePort }): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const setRemoteBrowserPageHandle = useAppStore((s) => s.setRemoteBrowserPageHandle)
  const setWorkspacePortScan = useAppStore((s) => s.setWorkspacePortScan)
  const setWorkspacePortScanRefreshing = useAppStore((s) => s.setWorkspacePortScanRefreshing)
  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const processLabel = port.processName ?? (port.pid ? `PID ${port.pid}` : 'Unknown process')
  const canStop = canStopWorkspacePort(port)

  const handleOpen = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      void openWorkspacePortInBrowser({
        port,
        runtimeTarget,
        createBrowserTab,
        setRemoteBrowserPageHandle
      }).then((result) => {
        if (!result.ok) {
          toast.error('Failed to open browser', { description: result.reason })
        }
      })
    },
    [createBrowserTab, port, runtimeTarget, setRemoteBrowserPageHandle]
  )

  const handleCopy = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      void window.api.ui.writeClipboardText(addressForPort(port))
      toast.success(`Copied :${port.port}`)
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
        toast.success(`Stopped process on :${port.port}`)
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
    <div className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/50">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 font-mono text-[12px] font-semibold text-foreground">
          :{port.port}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">{processLabel}</span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <PortAction label="Open in Orca Browser" onClick={handleOpen}>
          <ExternalLink className="size-3" />
        </PortAction>
        <PortAction label={`Copy ${addressForPort(port)}`} onClick={handleCopy}>
          <Copy className="size-3" />
        </PortAction>
        {canStop && (
          <PortAction label="Stop Process" onClick={handleStop}>
            <Trash2 className="size-3" />
          </PortAction>
        )}
      </div>
    </div>
  )
}

export function WorktreeCardPorts({ ports }: WorktreeCardPortsProps): React.JSX.Element | null {
  if (ports.length === 0) {
    return null
  }

  return (
    <HoverCard openDelay={250} closeDelay={120}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="inline-flex size-3.5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring"
          aria-label={`${ports.length} live ${ports.length === 1 ? 'port' : 'ports'}`}
          onClick={(event) => event.stopPropagation()}
        >
          <Cable className="size-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-72 p-2 text-xs"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          <Cable className="size-3" />
          <span>Live Ports</span>
          <span className="ml-auto font-normal tabular-nums text-muted-foreground/70">
            {ports.length}
          </span>
        </div>
        <div className="space-y-0.5">
          {ports.map((port) => (
            <WorktreePortRow key={port.id} port={port} />
          ))}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
